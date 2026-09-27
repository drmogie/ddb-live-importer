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
 *   6. Back in Foundry, GM clicks "Paste Character Data." This module reads
 *      the clipboard, maps the data (see ddb-mapper.js), and either creates
 *      a new actor, updates the actor being converted, or updates an
 *      existing actor matched by name.
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

async function readClipboardCharacter() {
  let text;
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    throw new Error(game.i18n.localize("DDBLI.ImportFailedClipboard"));
  }
  if (!text || !text.trim()) {
    throw new Error(game.i18n.localize("DDBLI.ImportFailedEmpty"));
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(game.i18n.localize("DDBLI.ImportFailedParse"));
  }
  return json;
}

/** Replace an actor's class/gear items with a freshly mapped set. */
async function replaceItems(actor, items) {
  await actor.deleteEmbeddedDocuments(
    "Item",
    actor.items.filter(i => ["class", "weapon", "equipment", "consumable", "loot"].includes(i.type)).map(i => i.id)
  );
  await actor.createEmbeddedDocuments("Item", items);
}

/** Create a new actor, or update one matched by name, from clipboard data. */
async function importFromClipboard() {
  const raw = await readClipboardCharacter();
  const { actorData, items, raw: ddbData } = mapDdbCharacterToActor(raw);

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

/** Convert/re-sync one specific actor (from the right-click menu) from clipboard data. */
async function convertActorFromClipboard(actor) {
  const raw = await readClipboardCharacter();
  const { actorData, items, raw: ddbData } = mapDdbCharacterToActor(raw);

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
    target.disabled = true;
    try {
      if (this.targetActor) {
        await convertActorFromClipboard(this.targetActor);
      } else {
        await importFromClipboard();
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
function liElement(li) {
  return li instanceof HTMLElement ? li : li?.[0] ?? null;
}

function liEntryId(li) {
  const el = liElement(li);
  return el?.dataset?.entryId ?? el?.dataset?.documentId ?? el?.getAttribute?.("data-entry-id") ?? null;
}

Hooks.on("getActorDirectoryEntryContext", (_html, entryOptions) => {
  entryOptions.push({
    name: "DDBLI.ContextConvert",
    icon: '<i class="fa-solid fa-dice-d20"></i>',
    condition: li => {
      if (!game.user.isGM) return false;
      const actor = game.actors.get(liEntryId(li));
      return actor?.type === "character";
    },
    callback: li => {
      const actor = game.actors.get(liEntryId(li));
      if (actor) new DDBImportDialog(actor).render(true);
    }
  });
});
