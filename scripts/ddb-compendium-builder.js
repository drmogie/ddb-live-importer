/**
 * D&D Beyond Live Importer -- Compendium Builder window.
 *
 * Builds world compendiums from the D&D Beyond books the GM owns:
 * one pack per book per type (Monsters, Spells, Items, Classes & Feats).
 *
 * Flow (no token is ever saved):
 *  1. GM copies a script and pastes it into the console of their own,
 *     already-logged-in D&D Beyond tab (see ddb-compendium-scraper.js).
 *  2. The script downloads a JSON file.
 *  3. GM picks that file here, ticks books, presses Build.
 */
import { buildScrapeScript, SCRAPE_TYPES } from "./ddb-compendium-scraper.js";
import { PACK_TYPES, mapBook, summarizeBook, packNameFor, packLabelFor } from "./ddb-compendium-mapper.js";

const MODULE_ID = "ddb-live-importer";
const DDB_LIBRARY_URL = "https://www.dndbeyond.com/en/library";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const TYPE_LABEL_KEYS = {
  monsters: "DDBLI.CB.TypeMonsters",
  spells: "DDBLI.CB.TypeSpells",
  items: "DDBLI.CB.TypeItems",
  feats: "DDBLI.CB.TypeFeats",
  classes: "DDBLI.CB.TypeClasses"
};

const t = (key, data) => (data ? game.i18n.format(key, data) : game.i18n.localize(key));

async function copyText(text) {
  if (game.clipboard?.copyPlainText) return game.clipboard.copyPlainText(text);
  return navigator.clipboard.writeText(text);
}

async function getOrCreatePack(bookName, typeKey) {
  const name = packNameFor(bookName, typeKey);
  let pack = game.packs.get(`world.${name}`);
  if (!pack) {
    const CC = foundry.documents?.collections?.CompendiumCollection ?? CompendiumCollection;
    pack = await CC.createCompendium({
      name,
      label: packLabelFor(bookName, typeKey),
      type: PACK_TYPES[typeKey].docType,
      packageType: "world"
    });
  }
  if (pack.locked) await pack.configure({ locked: false });
  return pack;
}

/** Write documents into a pack. Returns {created, replaced, skipped}. */
async function writeDocs(pack, docs, replaceExisting) {
  const index = await pack.getIndex();
  const byName = new Map();
  for (const e of index) {
    const list = byName.get(e.name) ?? [];
    list.push(e._id);
    byName.set(e.name, list);
  }
  let replaced = 0, skipped = 0;
  const toWrite = [];
  const toDelete = [];
  for (const d of docs) {
    const hit = byName.get(d.name);
    if (hit?.length) {
      if (replaceExisting) { toDelete.push(...hit); byName.delete(d.name); replaced++; toWrite.push(d); }
      else skipped++;
    } else toWrite.push(d);
  }
  if (toDelete.length) await pack.documentClass.deleteDocuments(toDelete, { pack: pack.collection });
  for (let i = 0; i < toWrite.length; i += 40) {
    await pack.documentClass.createDocuments(toWrite.slice(i, i + 40), { pack: pack.collection });
  }
  return { created: toWrite.length - replaced, replaced, skipped };
}

export class DDBCompendiumBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ddb-live-importer-compendium-builder",
    classes: ["ddb-live-importer", "ddbli-compendium-builder"],
    window: {
      title: "DDBLI.CB.Title",
      icon: "fa-solid fa-book-skull",
      resizable: true
    },
    position: { width: 560, height: "auto" },
    actions: {
      "open-library": DDBCompendiumBuilder.#onOpenLibrary,
      "copy-script": DDBCompendiumBuilder.#onCopyScript,
      "toggle-book": DDBCompendiumBuilder.#onToggleBook,
      "build": DDBCompendiumBuilder.#onBuild
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/compendium-builder.html` }
  };

  /** Which content types to read from D&D Beyond. */
  types = new Set(SCRAPE_TYPES);
  /** Optional book names typed by the GM (one per line). */
  titlesText = "";
  replaceExisting = false;
  /** The loaded ddb-books-v1 file. */
  #data = null;
  #selected = new Set();
  #status = "";
  #busy = false;

  async _prepareContext(_options) {
    const books = (this.#data?.books ?? []).map(b => {
      const s = summarizeBook(b);
      return { ...s, checked: this.#selected.has(String(b.id)), empty: !(s.monsters + s.spells + s.items + s.classesFeats) };
    });
    return {
      types: SCRAPE_TYPES.map(k => ({ key: k, label: t(TYPE_LABEL_KEYS[k]), checked: this.types.has(k) })),
      titlesText: this.titlesText,
      replaceExisting: this.replaceExisting,
      hasData: !!this.#data,
      books,
      selectedCount: this.#selected.size,
      status: this.#status,
      busy: this.#busy
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const el = this.element;

    el.querySelectorAll("input[data-type-key]").forEach(box => {
      box.addEventListener("change", () => {
        if (box.checked) this.types.add(box.dataset.typeKey);
        else this.types.delete(box.dataset.typeKey);
      });
    });
    el.querySelector("textarea[name='titles']")?.addEventListener("input", ev => { this.titlesText = ev.target.value; });
    el.querySelector("input[name='replace']")?.addEventListener("change", ev => { this.replaceExisting = ev.target.checked; });
    el.querySelector("input[name='file']")?.addEventListener("change", ev => this.#loadFile(ev.target.files?.[0]));
  }

  #setStatus(msg) {
    this.#status = msg;
    const line = this.element?.querySelector(".ddbli-cb-status");
    if (line) line.textContent = msg;
  }

  async #loadFile(file) {
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      if (json?.format !== "ddb-books-v1" || !Array.isArray(json.books)) throw new Error("format");
      this.#data = json;
      this.#selected = new Set(json.books.filter(b => {
        const s = summarizeBook(b);
        return s.monsters + s.spells + s.items + s.classesFeats > 0;
      }).map(b => String(b.id)));
      this.#status = t("DDBLI.CB.FileLoaded", { count: json.books.length });
    } catch (e) {
      console.error(`${MODULE_ID} | could not read file`, e);
      this.#data = null;
      this.#status = t("DDBLI.CB.FileBad");
    }
    this.render();
  }

  static #onOpenLibrary() {
    window.open(DDB_LIBRARY_URL, "_blank", "noopener");
  }

  static async #onCopyScript() {
    if (!this.types.size) return ui.notifications.warn(t("DDBLI.CB.PickType"));
    const titles = this.titlesText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const script = buildScrapeScript({ types: [...this.types], titles });
    try {
      await copyText(script);
      ui.notifications.info(t("DDBLI.CB.ScriptCopied"));
    } catch (e) {
      console.error(`${MODULE_ID} | clipboard failed`, e);
      ui.notifications.error(t("DDBLI.CB.CopyFailed"));
    }
  }

  static #onToggleBook(event, target) {
    const id = String(target.dataset.bookId);
    if (this.#selected.has(id)) this.#selected.delete(id);
    else this.#selected.add(id);
    this.render();
  }

  static async #onBuild() {
    if (this.#busy || !this.#data) return;
    const books = this.#data.books.filter(b => this.#selected.has(String(b.id)));
    if (!books.length) return ui.notifications.warn(t("DDBLI.CB.PickBook"));
    this.#busy = true;
    const totals = { packs: 0, created: 0, replaced: 0, skipped: 0 };
    try {
      for (const book of books) {
        const docsByType = mapBook(book);
        for (const [typeKey, docs] of Object.entries(docsByType)) {
          if (!docs.length) continue;
          this.#setStatus(t("DDBLI.CB.Building", { book: book.name, type: PACK_TYPES[typeKey].label, count: docs.length }));
          const pack = await getOrCreatePack(book.name, typeKey);
          const r = await writeDocs(pack, docs, this.replaceExisting);
          totals.packs++;
          totals.created += r.created;
          totals.replaced += r.replaced;
          totals.skipped += r.skipped;
        }
      }
      this.#setStatus(t("DDBLI.CB.Done", totals));
      ui.notifications.info(t("DDBLI.CB.Done", totals));
    } catch (e) {
      console.error(`${MODULE_ID} | compendium build failed`, e);
      this.#setStatus(t("DDBLI.CB.Failed", { error: e.message }));
      ui.notifications.error(t("DDBLI.CB.Failed", { error: e.message }));
    } finally {
      this.#busy = false;
    }
  }
}

/** Called once from the module's init hook. */
export function registerCompendiumBuilder() {
  game.settings.registerMenu(MODULE_ID, "compendiumBuilderMenu", {
    name: "DDBLI.CB.MenuName",
    label: "DDBLI.CB.MenuLabel",
    hint: "DDBLI.CB.MenuHint",
    icon: "fa-solid fa-book-skull",
    type: DDBCompendiumBuilder,
    restricted: true
  });
}
