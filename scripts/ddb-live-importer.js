/**
 * ddb-live-importer.js
 * ---------------------------------------------------------------------------
 * Standalone GM tool. No other modules required, no saved API token.
 *
 * Flow (no bookmarklet, no dragging):
 *   1. GM clicks "Import from D&D Beyond" (Actor Directory footer) for a
 *      brand new character, OR right-clicks an existing actor and picks
 *      "Convert to D&D Beyond Character" to re-sync one that already exists.
 *   2. Dialog opens; "Open D&D Beyond" launches a real browser tab to the
 *      GM's own (already logged in) D&D Beyond account.
 *   3. GM picks their campaign, then a character, then pastes that
 *      character's URL (or just the ID number) into the box.
 *   4. "Get Character JSON" opens the raw character data in a new tab (a
 *      plain link — no script runs on D&D Beyond's page at all).
 *   5. GM selects all (Ctrl+A) and copies (Ctrl+C) on that page.
 *   6. Back in Foundry, GM pastes (Ctrl+V) into the text box and clicks
 *      "Import Character." This module reads that text, maps the data (see
 *      ddb-mapper.js), swaps items for real compendium items where it can,
 *      and either creates a new actor, updates the actor being converted,
 *      or updates an existing actor matched by name.
 *
 * The character ID is saved on the actor afterward, so next time it's
 * pre-filled automatically for a quick re-sync.
 * ---------------------------------------------------------------------------
 */

import { mapDdbCharacterToActor } from "./ddb-mapper.js";

const MODULE_ID = "ddb-live-importer";
const DDB_CAMPAIGNS_URL = "https://www.dndbeyond.com/my-campaigns";
const DDB_CHARACTER_JSON_BASE = "https://character-service.dndbeyond.com/character/v5/character/";

/** Pull a D&D Beyond character ID out of a pasted URL or a bare number. */
function parseCharacterId(input) {
  if (!input) return null;
  const trimmed = String(input).trim();
  const urlMatch = trimmed.match(/\/characters\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  const digitsMatch = trimmed.match(/(\d{4,})/);
  return digitsMatch ? digitsMatch[1] : null;
}

function findExistingActor(name) {
  const target = name.trim().toLowerCase();
  return game.actors.find(
    a => a.type === "character" && a.name.trim().toLowerCase() === target
  );
}

/**
 * Item compendiums to search for a real match, in priority order. Confirmed
 * live against Po Tato's real gear on 2026-09-27: his weapons, armor, and
 * magic items (Vicious Glaive, Belt of Fire Giant Strength, Bag of Holding)
 * all matched exactly in dnd5e.items. Searching a pack that doesn't exist in
 * a given world is harmless -- it's just skipped.
 */
const ITEM_COMPENDIUM_IDS = [
  "world.ddb-underground-playground-ddb-items", // this world's own item pack, if present
  "dnd5e.items", // core SRD + classic DMG magic items
  "dnd5e.equipment24" // 2024-rules equipment
];

function normalizeItemName(name) {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

let _itemIndexCache = null;

/** Builds (once) a flat, normalized index across all the compendiums above. */
async function getItemCompendiumIndex() {
  if (_itemIndexCache) return _itemIndexCache;
  const entries = [];
  for (const packId of ITEM_COMPENDIUM_IDS) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    await pack.getIndex();
    for (const entry of pack.index) {
      entries.push({ pack, entry, normalized: normalizeItemName(entry.name) });
    }
  }
  _itemIndexCache = entries;
  return entries;
}

/** Drops a trailing "(...)" note D&D Beyond adds but compendiums don't, e.g. "Rations (1 day)" -> "Rations". */
function stripParenthetical(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** "Rope, Hempen" -> "Hempen Rope" -- D&D Beyond sometimes lists gear "Type, Descriptor" backwards from compendiums. */
function reorderComma(name) {
  const m = name.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2]} ${m[1]}` : null;
}

/** Every name variant worth trying, in order, for one D&D Beyond item name. */
function candidateNames(name) {
  const stripped = stripParenthetical(name);
  const candidates = [name];
  if (stripped !== name) candidates.push(stripped);
  for (const n of [name, stripped]) {
    const reordered = reorderComma(n);
    if (reordered) candidates.push(reordered);
  }
  candidates.push(`${name} Armor`); // "Adamantine Splint" -> compendium's "Adamantine Splint Armor"
  return [...new Set(candidates)];
}

/**
 * Looks for a real compendium item matching this D&D Beyond item's name.
 * Tries an exact match (after the cleanup above) first. If nothing matches
 * exactly, falls back to a "starts with" match -- confirmed live on
 * 2026-09-27 for D&D Beyond's "Rope, Hempen (50 feet)", which needs both the
 * comma reorder AND a starts-with match to find the compendium's "Hempen
 * Rope (50 ft.)". This is a looser check, so it's only tried once the exact
 * pass comes up empty, and it takes whichever compendium is highest
 * priority (the index is already built in that order).
 */
async function findCompendiumItem(name) {
  const index = await getItemCompendiumIndex();

  for (const candidate of candidateNames(name)) {
    const target = normalizeItemName(candidate);
    const exact = index.find(e => e.normalized === target);
    if (exact) return exact;
  }

  const looseTarget = normalizeItemName(reorderComma(stripParenthetical(name)) ?? stripParenthetical(name));
  if (looseTarget.length > 3) {
    const loose = index.find(e => e.normalized.startsWith(looseTarget));
    if (loose) return loose;
  }

  return null;
}

/**
 * Swaps our basic guessed items for the real compendium item wherever one
 * matches by name, keeping only the character-specific bits (quantity,
 * equipped, attuned) from what ddb-mapper.js built. Falls back to the basic
 * item when nothing matches (typically homebrew content). Class items are
 * left alone -- they're not in an item compendium.
 */
async function resolveItemsAgainstCompendiums(items) {
  const resolved = [];
  for (const basic of items) {
    if (basic.type === "class") {
      resolved.push(basic);
      continue;
    }
    const match = await findCompendiumItem(basic.name);
    if (!match) {
      resolved.push(basic);
      continue;
    }
    const doc = await match.pack.getDocument(match.entry._id);
    const data = doc.toObject();
    delete data._id;
    data.system.quantity = basic.system.quantity;
    data.system.equipped = basic.system.equipped;
    if ("attuned" in data.system) data.system.attuned = basic.system.attuned;
    resolved.push(data);
  }
  return resolved;
}

/**
 * Parses the JSON text the GM pasted into the textarea.
 *
 * IMPORTANT: this deliberately does NOT use navigator.clipboard.readText().
 * Foundry servers are very commonly reached over plain http:// (a LAN IP
 * like this one, no TLS cert) rather than https://. The Clipboard API's
 * read permission only works on a "secure context" (https, or localhost) --
 * on plain http it silently/consistently fails every time, which is exactly
 * the "Couldn't read the clipboard" error this module used to throw no
 * matter what the GM did. A normal Ctrl+V paste into a text field has no
 * such restriction, so that's what this module uses instead.
 */
function parseCharacterJson(text) {
  if (!text || !text.trim()) {
    throw new Error(game.i18n.localize("DDBLI.ImportFailedEmpty"));
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(game.i18n.localize("DDBLI.ImportFailedParse"));
  }
}

// Every non-class item type this module might create, so a re-sync clears
// out the old set cleanly -- including "tool"/"container", which only show
// up once a real compendium item (e.g. a Backpack) replaces our old "loot"
// guess for it.
const GEAR_ITEM_TYPES = ["weapon", "equipment", "consumable", "loot", "tool", "container"];

/** Replace an actor's class/gear items with a freshly mapped set. */
async function replaceItems(actor, items) {
  await actor.deleteEmbeddedDocuments(
    "Item",
    actor.items.filter(i => GEAR_ITEM_TYPES.includes(i.type)).map(i => i.id)
  );
  await actor.createEmbeddedDocuments("Item", items);
}

/** Create a new actor, or update one matched by name, from pasted JSON text. */
async function importFromJson(rawText) {
  const raw = parseCharacterJson(rawText);
  const { actorData, items: basicItems, raw: ddbData } = mapDdbCharacterToActor(raw);
  const items = await resolveItemsAgainstCompendiums(basicItems);

  console.log(`${MODULE_ID} | raw D&D Beyond character data`, ddbData);
  console.log(`${MODULE_ID} | mapped actor data`, actorData, items);

  const existing = findExistingActor(actorData.name);

  if (existing) {
    await existing.update(actorData);
    await replaceItems(existing, items);
    ui.notifications.info(game.i18n.format("DDBLI.ImportUpdated", { name: actorData.name }));
    existing.sheet.render(true);
  } else {
    const actor = await Actor.create(actorData);
    await actor.createEmbeddedDocuments("Item", items);
    ui.notifications.info(game.i18n.format("DDBLI.ImportCreated", { name: actorData.name }));
    actor.sheet.render(true);
  }
}

/** Convert/re-sync one specific actor (from the right-click menu) from pasted JSON text. */
async function convertActorFromJson(actor, rawText) {
  const raw = parseCharacterJson(rawText);
  const { actorData, items: basicItems, raw: ddbData } = mapDdbCharacterToActor(raw);
  const items = await resolveItemsAgainstCompendiums(basicItems);

  console.log(`${MODULE_ID} | raw D&D Beyond character data`, ddbData);
  console.log(`${MODULE_ID} | mapped actor data`, actorData, items);

  await actor.update(actorData);
  await replaceItems(actor, items);
  ui.notifications.info(game.i18n.format("DDBLI.ImportUpdated", { name: actorData.name }));
  actor.sheet.render(true);
}

// Foundry v13+ moved core Applications (including ActorDirectory and the
// window class you build dialogs from) to ApplicationV2. The renderX hooks
// now hand you a plain HTMLElement instead of a jQuery object, and the old
// Application/activateListeners(html) pattern (which needed html.find(...))
// throws immediately on that plain element. This is written against the
// current ApplicationV2 + HandlebarsApplicationMixin API.
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DDBImportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @param {Actor|null} targetActor - when set, this dialog re-syncs that specific actor instead of creating/matching by name. */
  constructor(targetActor = null, options = {}) {
    super(options);
    this.targetActor = targetActor;
    this.characterId = targetActor?.getFlag(MODULE_ID, "ddbCharacterId") ?? null;
  }

  static DEFAULT_OPTIONS = {
    id: "ddb-live-importer-dialog",
    classes: ["ddb-live-importer"],
    window: {
      title: "DDBLI.DialogTitle",
      icon: "fa-solid fa-dice-d20",
      resizable: false
    },
    position: { width: 480, height: "auto" },
    actions: {
      "open-ddb": DDBImportDialog.#onOpenDDB,
      "open-json": DDBImportDialog.#onOpenJson,
      paste: DDBImportDialog.#onPaste
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/import-dialog.html` }
  };

  get title() {
    return this.targetActor
      ? game.i18n.format("DDBLI.ConvertDialogTitle", { name: this.targetActor.name })
      : game.i18n.localize("DDBLI.DialogTitle");
  }

  async _prepareContext(_options) {
    return {
      isConvert: !!this.targetActor,
      actorName: this.targetActor?.name ?? "",
      savedId: this.characterId ?? ""
    };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    const input = this.element.querySelector('input[name="ddbUrl"]');
    const jsonBtn = this.element.querySelector('[data-action="open-json"]');
    if (!input || !jsonBtn) return;

    const sync = () => {
      this.characterId = parseCharacterId(input.value);
      jsonBtn.disabled = !this.characterId;
    };
    input.addEventListener("input", sync);
    sync();
  }

  static #onOpenDDB() {
    window.open(DDB_CAMPAIGNS_URL, "_blank", "noopener");
  }

  static #onOpenJson() {
    if (!this.characterId) return;
    window.open(`${DDB_CHARACTER_JSON_BASE}${this.characterId}`, "_blank", "noopener");
  }

  static async #onPaste(_event, target) {
    const textarea = this.element.querySelector('textarea[name="ddbJson"]');
    const text = textarea?.value ?? "";

    target.disabled = true;
    try {
      if (this.targetActor) {
        await convertActorFromJson(this.targetActor, text);
      } else {
        await importFromJson(text);
      }
      this.close();
    } catch (err) {
      ui.notifications.error(err.message);
      console.error(`${MODULE_ID} |`, err);
    } finally {
      target.disabled = false;
    }
  }
}

// Footer button in the Actor Directory: create a new actor or update one
// matched by name.
Hooks.on("renderActorDirectory", (app, html) => {
  try {
    if (!game.user.isGM) return;

    // Handles both a raw HTMLElement (v13+) and a jQuery-wrapped element
    // (pre-v13), instead of assuming one or the other.
    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el || el.querySelector(".ddb-live-importer-open")) return; // no double-add on re-render

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ddb-live-importer-open";
    button.innerHTML = `<i class="fa-solid fa-dice-d20"></i> ${game.i18n.localize("DDBLI.ButtonLabel")}`;
    button.addEventListener("click", () => new DDBImportDialog().render(true));

    const footer = el.querySelector(".directory-footer") ?? el.querySelector(".directory-header") ?? el;
    footer.appendChild(button);
  } catch (err) {
    // Fail loud in the console instead of silently never adding the button.
    console.error(`${MODULE_ID} | failed to add the Import button`, err);
  }
});

// Right-click an existing actor -> "Convert to D&D Beyond Character" to
// re-sync that specific actor (no name-matching needed, and the character
// ID is remembered on it for next time).
//
// NOT a Hooks.on("getActorDirectoryEntryContext", ...) call. CONFIRMED live
// on 2026-09-27 against Foundry v14.368: that hook is never called anymore
// (Hooks.call/callAll simply never fires for the actor directory's context
// menu -- verified by patching Hooks.callAll itself and watching it stay
// silent through a real right-click). Also confirmed live: the entry list
// is built exactly ONCE, the first time the directory ever constructs its
// context menu, and reused after that -- so this has to be in place before
// that first build, not added reactively. Patching the class method here,
// at module load (which always runs before the sidebar ever renders), is
// what actually works, and the entry shape itself changed too: "condition"
// is now "visible" and "callback" is now "onClick" (confirmed by reading
// a real core menu entry's own keys live).
Hooks.once("init", () => {
  const proto = foundry.applications.sidebar.tabs.ActorDirectory.prototype;
  const original = proto._getEntryContextOptions;

  proto._getEntryContextOptions = function (...args) {
    const options = original.apply(this, args);
    options.push({
      label: "DDBLI.ContextConvert",
      icon: '<i class="fa-solid fa-dice-d20"></i>',
      visible: li => {
        if (!game.user.isGM) return false;
        const actor = game.actors.get(li?.dataset?.entryId);
        return actor?.type === "character";
      },
      onClick: li => {
        const actor = game.actors.get(li?.dataset?.entryId);
        if (actor) new DDBImportDialog(actor).render(true);
      }
    });
    return options;
  };
});
