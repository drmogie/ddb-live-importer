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
 *
 * GM Sync Panel (game.settings.registerMenu, see the "init" hook at the
 * bottom): lists every character already linked to D&D Beyond in one place,
 * with a "sync one" button per character and a "sync all" button. "Sync all"
 * still can't reach D&D Beyond directly from Foundry's page (confirmed:
 * D&D Beyond blocks cross-origin fetches from any other site, CORS, so
 * there is no way to auto-pull by character ID alone without a browser tab
 * open to D&D Beyond itself) -- so it works by having the GM paste a short
 * script into a D&D Beyond tab's own console once per batch (that script
 * fetches every linked character with the GM's real login and copies the
 * results), then pasting those results back into the Sync Panel.
 * ---------------------------------------------------------------------------
 */

import { mapDdbCharacterToActor, DEFAULT_SYNC_OPTIONS, ITEM_TYPES_BY_CATEGORY } from "./ddb-mapper.js";
import { registerCompendiumBuilder } from "./ddb-compendium-builder.js";

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

/** The 5 sync-category toggles, one shared setting used by every import/update, single or bulk (registered in the settings.registerMenu block near the bottom of this file). */
const SYNC_CATEGORY_SETTING_KEYS = {
  basics: "syncBasics",
  gameDetails: "syncGameDetails",
  abilities: "syncAbilities",
  gear: "syncGear",
  extras: "syncExtras"
};

/**
 * Individual field-level toggles nested under each of the 5 sync
 * categories -- each only matters when that category's own master toggle
 * (SYNC_CATEGORY_SETTING_KEYS) is also on (see DEFAULT_SYNC_OPTIONS's
 * comment in ddb-mapper.js). Shown as a tabbed list in the "Sync
 * Settings" window, one tab per category. Added 2026-09-27 per user
 * request so a GM can sync one part of a category without the rest (e.g.
 * Gear items without touching currency).
 */
const CATEGORY_FIELD_SETTING_KEYS = {
  basics: {
    basicsName: "syncBasicsFieldName",
    basicsRace: "syncBasicsFieldRace",
    basicsBackground: "syncBasicsFieldBackground",
    basicsGender: "syncBasicsFieldGender",
    basicsAge: "syncBasicsFieldAge",
    basicsBiography: "syncBasicsFieldBiography"
  },
  gameDetails: {
    detailsClass: "syncDetailsFieldClass",
    detailsLevel: "syncDetailsFieldLevel",
    detailsXp: "syncDetailsFieldXp",
    detailsSize: "syncDetailsFieldSize",
    detailsSpeed: "syncDetailsFieldSpeed"
  },
  abilities: {
    abilitiesScores: "syncAbilitiesFieldScores",
    abilitiesHp: "syncAbilitiesFieldHp",
    abilitiesSkills: "syncAbilitiesFieldSkills",
    abilitiesSaves: "syncAbilitiesFieldSaves"
  },
  gear: {
    gearItems: "syncGearFieldItems",
    gearCurrency: "syncGearFieldCurrency"
  },
  extras: {
    extrasSpells: "syncExtrasFieldSpells",
    extrasFeatures: "syncExtrasFieldFeatures"
  }
};

/** Reads every sync toggle (5 category masters + every field nested under them) from world settings. Falls back to "everything on" if a setting isn't registered yet (shouldn't happen once init has run, but keeps this safe to call early/in tests). */
function getSyncOptions() {
  const opts = {};
  const allEntries = [
    ...Object.entries(SYNC_CATEGORY_SETTING_KEYS),
    ...Object.values(CATEGORY_FIELD_SETTING_KEYS).flatMap(fields => Object.entries(fields))
  ];
  for (const [key, settingKey] of allEntries) {
    try {
      opts[key] = game.settings.get(MODULE_ID, settingKey);
    } catch {
      opts[key] = DEFAULT_SYNC_OPTIONS[key];
    }
  }
  return opts;
}

/** Foundry's own default token image -- an actor that's never had a custom token set still has this. */
const DEFAULT_TOKEN_IMG = "icons/svg/mystery-man.svg";

/**
 * D&D Beyond gives every character a portrait, and this module already
 * uses it for the actor's own `img`. Foundry does NOT also default the
 * token to that same image -- a freshly created actor keeps the generic
 * "mystery man" token until someone sets one by hand. This fills the
 * token in with that same portrait too, but ONLY when no one has set a
 * real token yet (a brand-new actor has none; an existing one is only
 * touched here if its token is still the untouched Foundry default), so a
 * token the GM picked on purpose is never overwritten by a resync.
 */
function applyDefaultTokenImage(actorData, existingTokenSrc) {
  const avatarUrl = actorData.img;
  if (!avatarUrl) return;
  const hasCustomToken = existingTokenSrc && existingTokenSrc !== DEFAULT_TOKEN_IMG;
  if (hasCustomToken) return;
  actorData.prototypeToken = { texture: { src: avatarUrl } };
}

/**
 * Every sync (single or bulk) locks the actor down to GM-only edit access:
 * everyone else -- including anyone who previously had an explicit Owner
 * grant, e.g. the player set up when the actor was first created -- is set
 * to Observer (can see the sheet, can't change it). This stops a player
 * editing between syncs from getting silently overwritten by the next one.
 * GMs always have full access regardless of what's set here; Foundry treats
 * every GM user as an owner of everything, so this never locks the GM out.
 */
function lockedOwnership(existingOwnership = {}) {
  const OBSERVER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  const ownership = { default: OBSERVER };
  for (const key of Object.keys(existingOwnership)) {
    if (key === "default") continue;
    ownership[key] = OBSERVER;
  }
  return ownership;
}

/**
 * Reads the optional DDB Scraper Proxy base URL from settings (e.g.
 * "https://ddb-proxy.example.com") -- see the "ddb-scraper-proxy" Home
 * Assistant add-on. Empty string (default) means "not configured", and
 * every caller below treats that the same as "the proxy isn't reachable" --
 * falls back to the manual console-paste flow, no error shown.
 */
function proxyBaseUrl() {
  try {
    const raw = game.settings.get(MODULE_ID, "ddbProxyUrl") ?? "";
    return raw.trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Tries to fetch one character's raw JSON through the proxy. Returns the
 * parsed data on success, or null on ANY failure -- not configured, network
 * error, or the proxy's own pass-through of D&D Beyond's error (typically
 * because the character is private, which the proxy can never get around
 * since it has no login of its own). null always means "fall back to the
 * manual flow," never a thrown error -- this is meant to be tried eagerly
 * and cheaply, not to be the only path.
 */
async function fetchCharacterViaProxy(characterId) {
  const base = proxyBaseUrl();
  if (!base || !characterId) return null;
  try {
    const res = await fetch(`${base}/character/${characterId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.warn(`${MODULE_ID} | proxy fetch failed`, err);
    return null;
  }
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

/**
 * Spell compendiums to search for a real match, same priority pattern as
 * ITEM_COMPENDIUM_IDS above. This world's own "ddb-spells" pack is DDB's own
 * synced content, so it's checked first.
 */
const SPELL_COMPENDIUM_IDS = [
  "world.ddb-underground-playground-ddb-spells",
  "dnd5e.spells",
  "dnd5e.spells24"
];

/**
 * Feat / class-feature compendiums to search for a real match. This world's
 * own "ddb-feats" pack (DDB's own synced content) is checked first, so most
 * of Po Tato's real feats (Charger, Great Weapon Fighting, Polearm Master,
 * etc.) matched here on 2026-09-27 and pulled in their actual Foundry
 * mechanics (active effects) instead of a plain description-only item.
 * "classfeatures" covers core class features (Second Wind, Action Surge).
 */
const FEAT_COMPENDIUM_IDS = [
  "world.ddb-underground-playground-ddb-feats",
  "dnd5e.classfeatures",
  "dnd5e.feats24"
];

/** Item type -> which compendium list to search. Falls back to ITEM_COMPENDIUM_IDS (gear) for anything not listed here. */
const COMPENDIUM_IDS_BY_TYPE = {
  spell: SPELL_COMPENDIUM_IDS,
  feat: FEAT_COMPENDIUM_IDS
};

function normalizeItemName(name) {
  return (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const _compendiumIndexCache = new Map();

/** Builds (once per distinct pack list) a flat, normalized index across the given compendiums. */
async function getCompendiumIndex(packIds) {
  const cacheKey = packIds.join("|");
  if (_compendiumIndexCache.has(cacheKey)) return _compendiumIndexCache.get(cacheKey);
  const entries = [];
  for (const packId of packIds) {
    const pack = game.packs.get(packId);
    if (!pack) continue;
    await pack.getIndex();
    for (const entry of pack.index) {
      entries.push({ pack, entry, normalized: normalizeItemName(entry.name) });
    }
  }
  _compendiumIndexCache.set(cacheKey, entries);
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
async function findCompendiumItem(name, packIds) {
  const index = await getCompendiumIndex(packIds);

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
 * Swaps our basic guessed items (gear, spells, feats/class-features) for the
 * real compendium item wherever one matches by name -- gear keeps only its
 * character-specific bits (quantity, equipped, attuned) from what
 * ddb-mapper.js built; spells keep their character-specific casting bits
 * (prepared, method, uses) since a generic compendium spell doesn't know
 * whether THIS character has it as an innate grant with limited uses. Falls
 * back to the basic item when nothing matches (typically homebrew content).
 * Class items are left alone -- they're not in an item compendium.
 */
async function resolveItemsAgainstCompendiums(items) {
  const resolved = [];
  for (const basic of items) {
    if (basic.type === "class") {
      resolved.push(basic);
      continue;
    }
    const packIds = COMPENDIUM_IDS_BY_TYPE[basic.type] ?? ITEM_COMPENDIUM_IDS;
    const match = await findCompendiumItem(basic.name, packIds);
    if (!match) {
      resolved.push(basic);
      continue;
    }
    const doc = await match.pack.getDocument(match.entry._id);
    const data = doc.toObject();
    delete data._id;
    if (basic.type === "spell") {
      data.system.prepared = basic.system.prepared;
      data.system.method = basic.system.method;
      if (basic.system.uses) data.system.uses = basic.system.uses;
    } else if (basic.type !== "feat") {
      data.system.quantity = basic.system.quantity;
      data.system.equipped = basic.system.equipped;
      if ("attuned" in data.system) data.system.attuned = basic.system.attuned;
    }
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

/**
 * Replace only the item types belonging to categories actually being synced
 * this run, leaving everything else on the actor untouched -- so e.g.
 * turning "Gear" off for a sync doesn't delete existing gear, it just skips
 * touching it. "categories" is the same {basics, gameDetails, abilities,
 * gear, extras} object mapDdbCharacterToActor() was called with.
 */
async function replaceItems(actor, items, categories) {
  const typesToClear = Object.entries(categories)
    .filter(([, on]) => on)
    .flatMap(([category]) => ITEM_TYPES_BY_CATEGORY[category] ?? []);
  if (typesToClear.length) {
    await actor.deleteEmbeddedDocuments(
      "Item",
      actor.items.filter(i => typesToClear.includes(i.type)).map(i => i.id)
    );
  }
  if (items.length) await actor.createEmbeddedDocuments("Item", items);
}

/**
 * Shared core of every sync, single or bulk: maps raw D&D Beyond JSON,
 * resolves items against compendiums, locks ownership to GM-only, and
 * writes it all to an existing actor. Returns the actor name for callers
 * that want to report it (the bulk Sync Panel's result line).
 */
async function syncActorFromDdbData(actor, raw, options = getSyncOptions()) {
  const { actorData, items: basicItems, raw: ddbData, syncedCategories } = mapDdbCharacterToActor(raw, options);
  const items = await resolveItemsAgainstCompendiums(basicItems);
  actorData.ownership = lockedOwnership(actor.ownership);

  // Name is the one field the mapper always fills in unconditionally (a
  // brand-new actor needs a name to even be created), but on a *resync* of
  // an existing actor it now respects its own toggle -- handled here
  // rather than in the mapper, since the mapper has no way to tell a fresh
  // create from a resync.
  if (!(options.basics && options.basicsName)) delete actorData.name;

  applyDefaultTokenImage(actorData, actor.prototypeToken?.texture?.src);

  console.log(`${MODULE_ID} | raw D&D Beyond character data`, ddbData);
  console.log(`${MODULE_ID} | mapped actor data`, actorData, items);

  await actor.update(actorData);
  await replaceItems(actor, items, syncedCategories);
  return actor.name;
}

/** Create a new actor, or update one matched by name, from pasted JSON text. */
async function importFromJson(rawText) {
  const raw = parseCharacterJson(rawText);
  const options = getSyncOptions();
  const existing = findExistingActor((raw?.data ?? raw)?.name ?? "");

  if (existing) {
    const name = await syncActorFromDdbData(existing, raw, options);
    ui.notifications.info(game.i18n.format("DDBLI.ImportUpdated", { name }));
    existing.sheet.render(true);
  } else {
    const { actorData, items: basicItems, syncedCategories } = mapDdbCharacterToActor(raw, options);
    const items = await resolveItemsAgainstCompendiums(basicItems);
    actorData.ownership = lockedOwnership();
    applyDefaultTokenImage(actorData, null);
    console.log(`${MODULE_ID} | mapped actor data`, actorData, items);
    const actor = await Actor.create(actorData);
    await actor.createEmbeddedDocuments("Item", items);
    ui.notifications.info(game.i18n.format("DDBLI.ImportCreated", { name: actorData.name }));
    actor.sheet.render(true);
  }
}

/** Convert/re-sync one specific actor (from the right-click menu) from pasted JSON text. */
async function convertActorFromJson(actor, rawText) {
  const raw = parseCharacterJson(rawText);
  const name = await syncActorFromDdbData(actor, raw);
  ui.notifications.info(game.i18n.format("DDBLI.ImportUpdated", { name }));
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
    const textarea = this.element.querySelector('textarea[name="ddbJson"]');
    const statusEl = this.element.querySelector(".ddbli-proxy-status");
    if (!input || !jsonBtn) return;

    let debounceTimer = null;

    // Tries the DDB Scraper Proxy for this id (if one's configured) a beat
    // after the GM stops typing/right after paste. On success, fills the
    // paste box automatically -- the GM just clicks Import Character, no
    // "open D&D Beyond / copy / paste" steps needed at all. On failure
    // (proxy not configured, unreachable, or the character's private),
    // says so and leaves the normal manual flow exactly as it was.
    const tryProxy = async (id) => {
      if (!statusEl || !textarea) return;
      statusEl.hidden = false;
      statusEl.textContent = game.i18n.localize("DDBLI.ProxyStatusChecking");
      const data = await fetchCharacterViaProxy(id);
      if (this.characterId !== id) return; // id changed while this was in flight
      if (data) {
        textarea.value = JSON.stringify(data);
        statusEl.textContent = game.i18n.localize("DDBLI.ProxyStatusFetched");
      } else {
        statusEl.textContent = game.i18n.localize("DDBLI.ProxyStatusUnavailable");
      }
    };

    const sync = () => {
      this.characterId = parseCharacterId(input.value);
      jsonBtn.disabled = !this.characterId;
      clearTimeout(debounceTimer);
      if (this.characterId && proxyBaseUrl()) {
        debounceTimer = setTimeout(() => tryProxy(this.characterId), 400);
      } else if (statusEl) {
        statusEl.hidden = true;
      }
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

/** Builds the script the GM pastes into a D&D Beyond tab's own console. Runs there (real same-origin fetch, real login cookie), fetches every given character ID, and uses the console's own `copy()` helper to put the results on the clipboard -- no script ever runs on D&D Beyond's page except this, and only when the GM explicitly pastes and runs it there themselves. */
function buildFetchAllScript(characterIds) {
  return `(async () => {
  const ids = ${JSON.stringify(characterIds)};
  const base = ${JSON.stringify(DDB_CHARACTER_JSON_BASE)};
  const results = [];
  for (const id of ids) {
    try {
      const res = await fetch(base + id, { credentials: "include" });
      const data = await res.json();
      results.push({ id, ok: res.ok, data });
    } catch (err) {
      results.push({ id, ok: false, error: String(err) });
    }
  }
  copy(JSON.stringify(results));
  console.log("ddb-live-importer: fetched " + ids.length + " character(s) and copied the results. Switch to Foundry and paste into the Sync Panel.");
})();`;
}

/** Applies one {id, ok, data, error} fetch result to whichever linked actor has that D&D Beyond character id. */
async function syncOneFromFetchResult(entry, linkedActors, options) {
  const actor = linkedActors.find(
    a => String(a.getFlag(MODULE_ID, "ddbCharacterId")) === String(entry.id)
  );
  if (!actor) throw new Error(`No linked actor found for D&D Beyond character #${entry.id}.`);
  if (!entry.ok || !entry.data) throw new Error(entry.error || `D&D Beyond fetch failed for #${entry.id}.`);
  await syncActorFromDdbData(actor, entry.data, options);
  return actor.name;
}

/**
 * "Sync Settings" -- the GM-only advanced window holding everything this
 * module needs configured EXCEPT the Proxy URL (which stays on Foundry's
 * own Configure Settings screen, at the top, per Mogie): one tab per sync
 * category (Basics/Details/Abilities/Gear/Extras), each with its own
 * "Sync All (This Category)" master plus every individual field under
 * it, and the manual (console-paste) "Sync All" flow for characters the
 * DDB Scraper Proxy can't reach. The everyday "Sync Panel" window (below)
 * is kept deliberately minimal -- just portraits and a result line -- for
 * quick day-to-day syncing.
 */
class DDBSettingsPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ddb-live-importer-settings-panel",
    classes: ["ddb-live-importer", "ddbli-sync-panel"],
    window: {
      title: "DDBLI.SyncSettingsTitle",
      icon: "fa-solid fa-gear",
      resizable: true
    },
    position: { width: 520, height: "auto" },
    actions: {
      "switch-tab": DDBSettingsPanel.#onSwitchTab,
      "open-ddb": DDBSettingsPanel.#onOpenDDB,
      "copy-script": DDBSettingsPanel.#onCopyScript,
      "auto-fetch-proxy": DDBSettingsPanel.#onAutoFetchProxy,
      "process-results": DDBSettingsPanel.#onProcessResults
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/settings-panel.html` }
  };

  /** Which category tab is showing. Kept across re-renders while this panel instance stays open. */
  activeTab = "basics";

  /** Every actor this module has already linked to a D&D Beyond character id -- same lookup DDBSyncPanel uses below, duplicated here since the bulk Sync All/Auto-Fetch actions live in this separate Application instance now. */
  #linkedActors() {
    return game.actors.filter(a => a.type === "character" && a.getFlag(MODULE_ID, "ddbCharacterId"));
  }

  async _prepareContext(_options) {
    const settingKeys = [
      ...Object.values(SYNC_CATEGORY_SETTING_KEYS),
      ...Object.values(CATEGORY_FIELD_SETTING_KEYS).flatMap(fields => Object.values(fields))
    ];
    const values = {};
    for (const key of settingKeys) values[key] = game.settings.get(MODULE_ID, key);

    return {
      ...values,
      isBasicsTab: this.activeTab === "basics",
      isDetailsTab: this.activeTab === "gameDetails",
      isAbilitiesTab: this.activeTab === "abilities",
      isGearTab: this.activeTab === "gear",
      isExtrasTab: this.activeTab === "extras",
      characterCount: this.#linkedActors().length,
      proxyConfigured: !!proxyBaseUrl(),
      resultLine: this._resultLine ?? ""
    };
  }

  /** Every checkbox here saves the instant it's clicked -- no separate Save button, matching how every other toggle in this module already behaves. */
  async _onRender(context, options) {
    await super._onRender(context, options);
    for (const input of this.element.querySelectorAll("input[data-setting]")) {
      input.addEventListener("change", () => {
        game.settings.set(MODULE_ID, input.dataset.setting, input.checked);
      });
    }
  }

  static #onSwitchTab(_event, target) {
    this.activeTab = target.dataset.tab;
    this.render();
  }

  static #onOpenDDB() {
    window.open(DDB_CAMPAIGNS_URL, "_blank", "noopener");
  }

  static async #onCopyScript() {
    const ids = this.#linkedActors()
      .map(a => a.getFlag(MODULE_ID, "ddbCharacterId"))
      .filter(Boolean);
    const script = buildFetchAllScript(ids);
    try {
      await navigator.clipboard.writeText(script);
      ui.notifications.info(game.i18n.localize("DDBLI.ScriptCopied"));
    } catch (err) {
      ui.notifications.error(err.message);
      console.error(`${MODULE_ID} |`, err);
    }
  }

  /**
   * "Sync All" via the proxy: for every linked character, tries the proxy
   * first (works for anything set to Public on D&D Beyond) and syncs it
   * immediately on success -- no console-paste step at all for those. A
   * character the proxy can't get (private, or the proxy unreachable) is
   * left untouched and named in the result line, same as any Sync All
   * partial failure -- the console-paste flow below still covers it.
   */
  static async #onAutoFetchProxy(_event, target) {
    target.disabled = true;
    try {
      const linkedActors = this.#linkedActors();
      const options = getSyncOptions();
      let done = 0;
      const remainingNames = [];

      for (const actor of linkedActors) {
        const characterId = actor.getFlag(MODULE_ID, "ddbCharacterId");
        const data = await fetchCharacterViaProxy(characterId);
        if (!data) {
          remainingNames.push(actor.name);
          continue;
        }
        try {
          await syncActorFromDdbData(actor, data, options);
          done++;
        } catch (err) {
          remainingNames.push(actor.name);
          console.error(`${MODULE_ID} |`, err);
        }
      }

      const total = linkedActors.length;
      this._resultLine = remainingNames.length
        ? `${game.i18n.format("DDBLI.ProxyAutoFetchResult", { done, total, remaining: remainingNames.length })} ${game.i18n.format("DDBLI.SyncAllFailedNames", { names: remainingNames.join(", ") })}`
        : game.i18n.format("DDBLI.ProxyAutoFetchResult", { done, total, remaining: 0 });
      this.render();
    } finally {
      target.disabled = false;
    }
  }

  static async #onProcessResults(_event, target) {
    const textarea = this.element.querySelector('textarea[name="resultsJson"]');
    const text = textarea?.value ?? "";

    target.disabled = true;
    try {
      if (!text.trim()) throw new Error(game.i18n.localize("DDBLI.SyncAllResultsEmpty"));
      let entries;
      try {
        entries = JSON.parse(text);
      } catch {
        throw new Error(game.i18n.localize("DDBLI.SyncAllResultsParseFailed"));
      }

      const linkedActors = this.#linkedActors();
      const options = getSyncOptions();
      let done = 0;
      const failedNames = [];
      for (const entry of entries) {
        try {
          await syncOneFromFetchResult(entry, linkedActors, options);
          done++;
        } catch (err) {
          failedNames.push(`#${entry.id}`);
          console.error(`${MODULE_ID} |`, err);
        }
      }

      const total = entries.length;
      this._resultLine = failedNames.length
        ? `${game.i18n.format("DDBLI.SyncAllResult", { done, total, failed: failedNames.length })} ${game.i18n.format("DDBLI.SyncAllFailedNames", { names: failedNames.join(", ") })}`
        : game.i18n.format("DDBLI.SyncAllResult", { done, total, failed: 0 });
      textarea.value = "";
      this.render();
    } catch (err) {
      ui.notifications.error(err.message);
      console.error(`${MODULE_ID} |`, err);
    } finally {
      target.disabled = false;
    }
  }
}

/**
 * "Sync Panel" -- the everyday, GM-only main window: every D&D
 * Beyond-linked character shown as a clickable portrait, multi-select,
 * one "Sync Selected" button, one result line. Everything else (the
 * category tabs and the manual console-paste flow) lives in the separate
 * "Sync Settings" window above instead, kept out of this one on purpose
 * so this stays the fast, everyday tool.
 */
class DDBSyncPanel extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ddb-live-importer-sync-panel",
    classes: ["ddb-live-importer", "ddbli-sync-panel"],
    window: {
      title: "DDBLI.SyncPanelTitle",
      icon: "fa-solid fa-dice-d20",
      resizable: true
    },
    position: { width: 420, height: "auto" },
    actions: {
      "toggle-select": DDBSyncPanel.#onToggleSelect,
      "sync-selected": DDBSyncPanel.#onSyncSelected,
      "open-settings": DDBSyncPanel.#onOpenSettings
    }
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/sync-panel.html` }
  };

  /** D&D Beyond-linked actor ids the GM has clicked on in the portrait grid. Kept selected across re-renders while this panel instance stays open. */
  selectedIds = new Set();

  /** Every actor this module has already linked to a D&D Beyond character id. */
  #linkedActors() {
    return game.actors.filter(a => a.type === "character" && a.getFlag(MODULE_ID, "ddbCharacterId"));
  }

  async _prepareContext(_options) {
    const linked = this.#linkedActors();
    return {
      selectedCount: this.selectedIds.size,
      characters: linked.map(a => {
        const lastImported = a.getFlag(MODULE_ID, "lastImported");
        return {
          id: a.id,
          name: a.name,
          img: a.img,
          selected: this.selectedIds.has(a.id),
          lastSyncedLabel: lastImported ? new Date(lastImported).toLocaleString() : game.i18n.localize("DDBLI.NeverSynced")
        };
      }),
      resultLine: this._resultLine ?? ""
    };
  }

  /** Clicking a portrait toggles it in/out of the selection (amber aura is purely CSS off the .ddbli-selected class this adds/removes via re-render). */
  static #onToggleSelect(_event, target) {
    const id = target.dataset.actorId;
    if (!id) return;
    if (this.selectedIds.has(id)) this.selectedIds.delete(id);
    else this.selectedIds.add(id);
    this.render();
  }

  /**
   * Syncs exactly the characters selected in the portrait grid -- one or
   * several. Tries the proxy first for each, so any selected public
   * character syncs immediately with no manual step. If exactly one
   * character was selected and the proxy couldn't get it (private, or no
   * proxy configured), opens that character's normal Import/Update
   * dialog instead. With several selected and some still needing the
   * manual step, those are named in the result line -- open Sync
   * Settings for the manual console-paste flow that covers them.
   */
  static async #onSyncSelected(_event, target) {
    if (this.selectedIds.size === 0) return;
    target.disabled = true;
    try {
      const linkedActors = this.#linkedActors();
      const selected = linkedActors.filter(a => this.selectedIds.has(a.id));
      const options = getSyncOptions();
      let done = 0;
      const remainingActors = [];

      for (const actor of selected) {
        const characterId = actor.getFlag(MODULE_ID, "ddbCharacterId");
        const data = await fetchCharacterViaProxy(characterId);
        if (!data) {
          remainingActors.push(actor);
          continue;
        }
        try {
          await syncActorFromDdbData(actor, data, options);
          done++;
        } catch (err) {
          remainingActors.push(actor);
          console.error(`${MODULE_ID} |`, err);
        }
      }

      this.selectedIds.clear();

      if (remainingActors.length === 1 && selected.length === 1) {
        this._resultLine = "";
        this.render();
        new DDBImportDialog(remainingActors[0]).render(true);
        return;
      }

      const total = selected.length;
      this._resultLine = remainingActors.length
        ? `${game.i18n.format("DDBLI.SyncSelectedResult", { done, total, remaining: remainingActors.length })} ${game.i18n.format("DDBLI.SyncAllFailedNames", { names: remainingActors.map(a => a.name).join(", ") })}`
        : game.i18n.format("DDBLI.SyncSelectedResult", { done, total, remaining: 0 });
      this.render();
    } finally {
      target.disabled = false;
    }
  }

  /** Small link to the separate Sync Settings window, so it's reachable from here without hunting through Foundry's Configure Settings screen. */
  static #onOpenSettings() {
    new DDBSettingsPanel().render(true);
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
/** Registers one of this module's boolean sync toggles, deriving its name/hint localization keys from the setting key itself (e.g. "syncBasics" -> DDBLI.SettingSyncBasicsName/Hint) -- same convention every one of these settings already followed, just no longer copy-pasted per call site now that there are 10 of these instead of 5. */
function registerBooleanSetting(settingKey, defaultValue) {
  const cap = settingKey[0].toUpperCase() + settingKey.slice(1);
  game.settings.register(MODULE_ID, settingKey, {
    name: `DDBLI.Setting${cap}Name`,
    hint: `DDBLI.Setting${cap}Hint`,
    scope: "world",
    config: false,
    type: Boolean,
    default: defaultValue
  });
}

Hooks.once("init", () => {
  // Optional DDB Scraper Proxy base URL (see the companion Home Assistant
  // add-on). Registered first so it's the top setting in this module's
  // row on the Configure Settings screen (per Mogie). Blank by default --
  // every caller treats blank the same as "not reachable" and falls back
  // to the manual console-paste flow, so leaving this empty is a fully
  // supported, unchanged experience.
  game.settings.register(MODULE_ID, "ddbProxyUrl", {
    name: "DDBLI.SettingProxyUrlName",
    hint: "DDBLI.SettingProxyUrlHint",
    scope: "world",
    config: true,
    type: String,
    default: ""
  });

  // Every sync category's master toggle, then its individual fields
  // registered right after it -- world-scope so every user (in practice,
  // only the GM can ever trigger a sync) follows the same toggles. All of
  // these are config:false (see registerBooleanSetting) since they're now
  // edited through the tabbed "Sync Settings" window instead of Foundry's
  // flat Configure Settings list -- still fully game.settings.get/set-able
  // exactly as before, just not auto-rendered there.
  for (const [category, settingKey] of Object.entries(SYNC_CATEGORY_SETTING_KEYS)) {
    registerBooleanSetting(settingKey, DEFAULT_SYNC_OPTIONS[category]);
    for (const [optKey, fieldSettingKey] of Object.entries(CATEGORY_FIELD_SETTING_KEYS[category] ?? {})) {
      registerBooleanSetting(fieldSettingKey, DEFAULT_SYNC_OPTIONS[optKey]);
    }
  }

  // Sync Settings: a button opening the advanced window that holds
  // everything except the Proxy URL above -- the tabbed category/field
  // toggles just registered, plus the manual console-paste "Sync All"
  // flow (see DDBSettingsPanel above).
  game.settings.registerMenu(MODULE_ID, "syncSettingsMenu", {
    name: "DDBLI.SyncSettingsMenuName",
    label: "DDBLI.SyncSettingsMenuLabel",
    hint: "DDBLI.SyncSettingsMenuHint",
    icon: "fa-solid fa-gear",
    type: DDBSettingsPanel,
    restricted: true
  });

  // Sync Panel: a button opening the everyday GM window -- every linked
  // character as a clickable portrait, multi-select, one Sync Selected
  // button, one result line (see DDBSyncPanel above).
  game.settings.registerMenu(MODULE_ID, "syncPanelMenu", {
    name: "DDBLI.SyncPanelMenuName",
    label: "DDBLI.SyncPanelMenuLabel",
    hint: "DDBLI.SyncPanelMenuHint",
    icon: "fa-solid fa-dice-d20",
    type: DDBSyncPanel,
    restricted: true
  });

  // Compendium Builder: one world compendium per owned book, per type
  // (see ddb-compendium-builder.js).
  registerCompendiumBuilder();

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
