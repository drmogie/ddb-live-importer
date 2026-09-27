/**
 * ddb-live-importer.js
 * ---------------------------------------------------------------------------
 * Standalone GM tool. No other modules required, no saved API token.
 *
 * Flow:
 *   1. GM clicks "Import from D&D Beyond" in the Actor Directory.
 *   2. Dialog opens; "Open D&D Beyond" launches a real browser tab/window to
 *      the GM's own (already logged in) D&D Beyond account.
 *   3. GM picks their campaign, then a character, then clicks the DDB Import
 *      bookmarklet on that character's page. The bookmarklet fetches the
 *      character JSON (using the GM's own D&D Beyond session, same as the
 *      page itself does) and copies it to the clipboard.
 *   4. Back in Foundry, GM clicks "Paste Character Data." This module reads
 *      the clipboard, maps the data (see ddb-mapper.js), and either creates
 *      a new actor or updates an existing one matched by name.
 * ---------------------------------------------------------------------------
 */

import { mapDdbCharacterToActor } from "./ddb-mapper.js";

const MODULE_ID = "ddb-live-importer";
const DDB_CAMPAIGNS_URL = "https://www.dndbeyond.com/my-campaigns";

/** The bookmarklet source, kept human-readable here and minified on demand. */
const BOOKMARKLET_SOURCE = `
(function () {
  var m = location.pathname.match(/\\/characters\\/(\\d+)/);
  if (!m) {
    alert("DDB Import: open a character's sheet page first, then click this bookmark.");
    return;
  }
  var id = m[1];
  fetch("https://character-service.dndbeyond.com/character/v5/character/" + id, {
    credentials: "include"
  })
    .then(function (r) {
      if (!r.ok) throw new Error("D&D Beyond returned " + r.status);
      return r.json();
    })
    .then(function (json) {
      var text = JSON.stringify(json);
      return navigator.clipboard.writeText(text).then(function () { return json; });
    })
    .then(function (json) {
      var name = (json && json.data && json.data.name) || "Character";
      alert("DDB Import: copied " + name + ". Switch to Foundry and click \\"Paste Character Data.\\"");
    })
    .catch(function (err) {
      alert("DDB Import failed: " + err.message);
    });
})();
`.trim();

function bookmarkletHref() {
  return "javascript:" + encodeURIComponent(BOOKMARKLET_SOURCE);
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

async function importFromClipboard() {
  const raw = await readClipboardCharacter();
  const { actorData, items, raw: ddbData } = mapDdbCharacterToActor(raw);

  // Full raw D&D Beyond JSON, for you to inspect/extend the mapper with.
  console.log(`${MODULE_ID} | raw D&D Beyond character data`, ddbData);
  console.log(`${MODULE_ID} | mapped actor data`, actorData, items);

  const existing = findExistingActor(actorData.name);

  if (existing) {
    await existing.update(actorData);
    await existing.deleteEmbeddedDocuments(
      "Item",
      existing.items.filter(i => ["class", "weapon", "equipment", "consumable", "loot"].includes(i.type)).map(i => i.id)
    );
    await existing.createEmbeddedDocuments("Item", items);
    ui.notifications.info(game.i18n.format("DDBLI.ImportUpdated", { name: actorData.name }));
    existing.sheet.render(true);
  } else {
    const actor = await Actor.create(actorData);
    await actor.createEmbeddedDocuments("Item", items);
    ui.notifications.info(game.i18n.format("DDBLI.ImportCreated", { name: actorData.name }));
    actor.sheet.render(true);
  }
}

// Foundry v13+ moved core Applications (including ActorDirectory and the
// window class you build dialogs from) to ApplicationV2. The renderX hooks
// now hand you a plain HTMLElement instead of a jQuery object, and the old
// Application/activateListeners(html) pattern (which needed html.find(...))
// throws immediately on that plain element. This is written against the
// current ApplicationV2 + HandlebarsApplicationMixin API.
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class DDBImportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
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
      paste: DDBImportDialog.#onPaste
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/import-dialog.html` }
  };

  async _prepareContext(_options) {
    return { bookmarkletHref: bookmarkletHref() };
  }

  static #onOpenDDB() {
    window.open(DDB_CAMPAIGNS_URL, "_blank", "noopener");
  }

  static async #onPaste(_event, target) {
    target.disabled = true;
    try {
      await importFromClipboard();
      this.close();
    } catch (err) {
      ui.notifications.error(err.message);
      console.error(`${MODULE_ID} |`, err);
    } finally {
      target.disabled = false;
    }
  }
}

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
