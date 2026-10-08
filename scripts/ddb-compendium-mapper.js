/**
 * D&D Beyond Live Importer -- Compendium Builder, Foundry side.
 *
 * Pure functions (no Foundry or browser globals) that turn the records the
 * browser script collected ("ddb-books-v1") into dnd5e document data.
 * Kept free of globals so tests/test-compendium.mjs can run them in Node.
 *
 * Own-use note: this only reshapes content the GM already owns on D&D Beyond.
 * Rules text goes in the description fields; it is not bundled with the module.
 */

/** One pack per book per type. "classes-feats" holds classes, class features and feats. */
export const PACK_TYPES = {
  monsters: { label: "Monsters", docType: "Actor" },
  spells: { label: "Spells", docType: "Item" },
  items: { label: "Items", docType: "Item" },
  "classes-feats": { label: "Classes & Feats", docType: "Item" }
};

export const slugify = s => String(s ?? "")
  .toLowerCase().replace(/[‘’']/g, "").replace(/&/g, "and")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Foundry pack names allow lowercase letters, numbers, dash and underscore. */
export function packNameFor(bookName, typeKey) {
  const base = `ddb-${slugify(bookName)}`.slice(0, 70).replace(/-+$/, "");
  return `${base}-${typeKey}`;
}

export const packLabelFor = (bookName, typeKey) => `${bookName} - ${PACK_TYPES[typeKey].label}`;

// ---- small text helpers -------------------------------------------------------
export const stripTags = html => String(html ?? "")
  .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"").replace(/&#0*39;|&rsquo;|&lsquo;/g, "'").replace(/\s+/g, " ").trim();

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (s, d = 0) => { const m = String(s ?? "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : d; };
const DEFAULT_IMG = "icons/svg/item-bag.svg";

/** Wrap plain text lines as <p> if the page gave no html. */
const descHtml = (html, fallbackText) => html || (fallbackText ? `<p>${esc(fallbackText)}</p>` : "");

// =============================================================================
// SPELLS
// =============================================================================
const SCHOOLS = {
  abjuration: "abj", conjuration: "con", divination: "div", enchantment: "enc",
  evocation: "evo", illusion: "ill", necromancy: "nec", transmutation: "trs"
};

export function parseSpellLevel(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("cantrip")) return 0;
  return num(t, 0);
}

export function parseCastingTime(s) {
  const t = String(s ?? "").toLowerCase();
  const n = num(t, 1);
  if (t.includes("bonus")) return { type: "bonus", value: 1 };
  if (t.includes("reaction")) return { type: "reaction", value: 1 };
  if (t.includes("minute")) return { type: "minute", value: n };
  if (t.includes("hour")) return { type: "hour", value: n };
  if (t.includes("day")) return { type: "day", value: n };
  if (t.includes("action")) return { type: "action", value: n };
  return { type: "special", value: n };
}

export function parseSpellRange(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.startsWith("self")) return { value: null, units: "self" };
  if (t.startsWith("touch")) return { value: null, units: "touch" };
  if (t.startsWith("sight")) return { value: null, units: "spec" };
  const n = num(t, 0);
  if (/\bmi\b|mile/.test(t) && n) return { value: n, units: "mi" };
  if (/ft|feet|foot/.test(t) && n) return { value: n, units: "ft" };
  return { value: null, units: "spec" };
}

export function parseSpellDuration(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.includes("instant")) return { value: null, units: "inst" };
  if (t.includes("until dispelled") || t.includes("permanent")) return { value: null, units: "perm" };
  const n = num(t, 1);
  if (/round/.test(t)) return { value: n, units: "round" };
  if (/minute/.test(t)) return { value: n, units: "minute" };
  if (/hour/.test(t)) return { value: n, units: "hour" };
  if (/day/.test(t)) return { value: n, units: "day" };
  if (/month/.test(t)) return { value: n, units: "month" };
  if (/year/.test(t)) return { value: n, units: "year" };
  if (/turn/.test(t)) return { value: n, units: "turn" };
  return { value: null, units: "spec" };
}

export function mapSpell(rec, bookName) {
  const p = rec.pairs ?? {};
  const haystack = `${(rec.tags ?? []).join(" ")} ${rec.head ?? ""} ${p.School ?? ""}`.toLowerCase();
  const school = Object.entries(SCHOOLS).find(([k]) => haystack.includes(k))?.[1] ?? "evo";
  const comps = String(p.Components ?? "");
  const properties = [];
  if (/\bV\b/.test(comps)) properties.push("vocal");
  if (/\bS\b/.test(comps)) properties.push("somatic");
  if (/\bM\b/.test(comps)) properties.push("material");
  const duration = String(p.Duration ?? "");
  if (/concentration/i.test(duration) || /concentration/i.test((rec.tags ?? []).join(" "))) properties.push("concentration");
  if (/ritual/i.test(`${p["Casting Time"] ?? ""} ${(rec.tags ?? []).join(" ")}`)) properties.push("ritual");
  return {
    name: rec.name || rec.listName,
    type: "spell",
    img: "icons/magic/symbols/runes-star-orange.webp",
    system: {
      description: { value: descHtml(rec.html) },
      level: parseSpellLevel(p.Level),
      school,
      activation: parseCastingTime(p["Casting Time"]),
      range: parseSpellRange(p["Range/Area"] ?? p.Range),
      duration: parseSpellDuration(duration.replace(/concentration,?\s*/i, "")),
      properties,
      materials: { value: rec.materials ?? "" },
      source: { book: bookName }
    },
    flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url } }
  };
}

// =============================================================================
// ITEMS (magic items and equipment)
// =============================================================================
const RARITIES = [
  ["very rare", "veryRare"], ["uncommon", "uncommon"], ["common", "common"],
  ["legendary", "legendary"], ["artifact", "artifact"], ["rare", "rare"]
];

export function detectRarity(s) {
  const t = String(s ?? "").toLowerCase();
  return RARITIES.find(([k]) => new RegExp(`\\b${k}\\b`).test(t))?.[1] ?? "";
}

/** Decide the dnd5e item type from the words D&D Beyond prints. */
export function detectItemType(s) {
  const t = String(s ?? "").toLowerCase();
  if (/\bweapon\b|\bsword\b|\bbow\b|\baxe\b|\bdagger\b|\bspear\b/.test(t) && !/armor/.test(t)) return "weapon";
  if (/\barmor\b|\bshield\b/.test(t)) return "equipment";
  if (/\bpotion\b|\bscroll\b|\belixir\b|\bammunition\b/.test(t)) return "consumable";
  if (/\bring\b|\brod\b|\bstaff\b|\bwand\b|\bwondrous\b|\bcloak\b|\bamulet\b|\bboots\b/.test(t)) return "equipment";
  if (/\btool\b|\bkit\b/.test(t)) return "tool";
  return "loot";
}

export function mapItem(rec, bookName) {
  const p = rec.pairs ?? {};
  const typeText = `${p.Type ?? ""} ${(rec.tags ?? []).join(" ")} ${rec.head ?? ""}`;
  const rarity = detectRarity(`${p.Rarity ?? ""} ${typeText}`);
  const attune = /requires attunement/i.test(`${typeText} ${rec.html ?? ""}`);
  const type = detectItemType(`${p.Type ?? ""} ${(rec.tags ?? []).join(" ")} ${(rec.head ?? "").slice(0, 160)}`);
  const system = {
    description: { value: descHtml(rec.html, rec.head) },
    rarity,
    attunement: attune ? "required" : "",
    quantity: 1,
    source: { book: bookName }
  };
  const cost = String(p.Cost ?? p.Price ?? "");
  const cm = cost.match(/([\d,.]+)\s*(pp|gp|ep|sp|cp)/i);
  if (cm) system.price = { value: Number(cm[1].replace(/,/g, "")), denomination: cm[2].toLowerCase() };
  const wt = String(p.Weight ?? "");
  const wm = wt.match(/([\d.]+)\s*(lb|kg)?/i);
  if (wm) system.weight = { value: Number(wm[1]), units: (wm[2] || "lb").toLowerCase() };
  return {
    name: rec.name || rec.listName,
    type,
    img: DEFAULT_IMG,
    system,
    flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url } }
  };
}

// =============================================================================
// FEATS, CLASSES, CLASS FEATURES
// =============================================================================
export function mapFeat(rec, bookName) {
  const text = stripTags(rec.html);
  const pre = (rec.head ?? text).match(/Prerequisite[s]?:?\s*([^.]{1,160})/i);
  return {
    name: rec.name || rec.listName,
    type: "feat",
    img: "icons/svg/upgrade.svg",
    system: {
      description: { value: descHtml(rec.html, rec.head) },
      type: { value: "feat", subtype: "" },
      requirements: pre ? pre[1].trim() : "",
      source: { book: bookName }
    },
    flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url } }
  };
}

/** Returns [classItem, ...featureItems] for one class page. */
export function mapClass(rec, bookName) {
  const name = (rec.name || rec.listName || "").replace(/\s+Class$/i, "").trim();
  const sections = rec.sections ?? [];
  const intro = sections.filter(s => s.level <= 2 && !/features?$/i.test(s.heading) && !s.heading.includes("Class Features")).slice(0, 2);
  const hd = (rec.head ?? "").match(/Hit (?:Point )?Die:?\s*(?:D|d)(\d+)/) || (rec.head ?? "").match(/\bd(6|8|10|12)\b per/i);
  const introHtml = intro.map(s => `${s.heading ? `<h3>${esc(s.heading)}</h3>` : ""}${s.paras.join("")}`).join("");
  const classItem = {
    name,
    type: "class",
    img: "icons/svg/shield.svg",
    system: {
      description: { value: introHtml },
      identifier: slugify(name),
      hitDice: hd ? `d${hd[1]}` : "d8",
      source: { book: bookName }
    },
    flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url } }
  };
  const features = [];
  for (const s of sections) {
    // real features sit under H3/H4 headings that are not the generic section titles
    if (s.level < 3 || !s.heading || !s.paras.length) continue;
    if (/^(becoming a|as a level|as a multiclass|creating a)/i.test(s.heading)) continue;
    features.push({
      name: s.heading,
      type: "feat",
      img: "icons/svg/aura.svg",
      system: {
        description: { value: s.paras.join("") },
        type: { value: "class", subtype: "" },
        requirements: name,
        source: { book: bookName }
      },
      flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url, className: name } }
    });
  }
  return [classItem, ...features];
}

// =============================================================================
// MONSTERS
// =============================================================================
const SIZES = { tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg" };
const CREATURE_TYPES = ["aberration", "beast", "celestial", "construct", "dragon", "elemental", "fey", "fiend", "giant", "humanoid", "monstrosity", "ooze", "plant", "undead"];
const SKILLS = {
  acrobatics: "acr", "animal handling": "ani", arcana: "arc", athletics: "ath", deception: "dec",
  history: "his", insight: "ins", intimidation: "itm", investigation: "inv", medicine: "med",
  nature: "nat", perception: "prc", performance: "prf", persuasion: "per", religion: "rel",
  "sleight of hand": "slt", stealth: "ste", survival: "sur"
};
const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"];

export function parseCR(s) {
  const t = String(s ?? "").trim();
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return num(t, 0);
}

export function parseMonsterMeta(meta) {
  const m = String(meta ?? "").match(/^(\w+)\s+(.+?)(?:\s*\(([^)]*)\))?\s*,\s*(.+)$/);
  if (!m) return { size: "med", type: "humanoid", subtype: "", alignment: "" };
  const typeWords = m[2].toLowerCase();
  const type = CREATURE_TYPES.find(t => typeWords.includes(t)) ?? "monstrosity";
  return { size: SIZES[m[1].toLowerCase()] ?? "med", type, subtype: m[3] ?? "", alignment: m[4].trim() };
}

export function parseMovement(s) {
  const out = { walk: 0, units: "ft" };
  const t = String(s ?? "").toLowerCase();
  const re = /(?:(walk|fly|swim|climb|burrow)\s+)?(\d+)\s*ft/g;
  let m, first = true;
  while ((m = re.exec(t))) {
    const key = m[1] ?? (first ? "walk" : null);
    if (key) out[key] = Number(m[2]);
    first = false;
  }
  if (/hover/.test(t)) out.hover = true;
  return out;
}

/** Split one description paragraph into a name and a body. */
export function splitFeatureParagraph(p) {
  const html = String(p ?? "");
  const m = html.match(/^<p>\s*(?:<(?:em|strong)>\s*)+([^<]+?)\.?\s*(?:<\/(?:em|strong)>\s*)+\.?\s*(.*)<\/p>$/i);
  if (m) return { name: stripTags(m[1]).replace(/\.$/, ""), body: m[2].trim() };
  return { name: null, body: html };
}

const ACTIVATION_BY_HEADING = [
  [/bonus/i, "bonus"], [/reaction/i, "reaction"], [/legendary/i, "legendary"],
  [/lair/i, "lair"], [/action/i, "action"], [/mythic/i, "special"]
];

export function mapMonster(rec, bookName) {
  const meta = parseMonsterMeta(rec.meta);
  const attrs = rec.attrs ?? {};
  const tid = rec.tidbits ?? {};
  const ab = rec.abilities ?? {};
  const hpText = attrs["Hit Points"] ?? "";
  const hpVal = num(hpText, 1);
  const hpFormula = (hpText.match(/\(([^)]+)\)/) ?? [])[1] ?? "";

  const abilities = {};
  ABILITY_KEYS.forEach(k => { abilities[k] = { value: Number.isFinite(ab[k]) ? ab[k] : 10 }; });
  String(tid["Saving Throws"] ?? "").split(",").forEach(part => {
    const key = part.trim().slice(0, 3).toLowerCase();
    if (abilities[key]) abilities[key].proficient = 1;
  });

  const skills = {};
  String(tid.Skills ?? "").split(",").forEach(part => {
    const name = part.replace(/[+-]?\d+/g, "").trim().toLowerCase();
    if (SKILLS[name]) skills[SKILLS[name]] = { value: 1 };
  });

  const senses = { units: "ft" };
  const senseText = String(tid.Senses ?? "").toLowerCase();
  for (const k of ["darkvision", "blindsight", "tremorsense", "truesight"]) {
    const m = senseText.match(new RegExp(`${k}\\s+(\\d+)`));
    if (m) senses[k] = Number(m[1]);
  }

  const items = [];
  for (const block of rec.blocks ?? []) {
    const heading = block.heading ?? "";
    const act = ACTIVATION_BY_HEADING.find(([rx]) => rx.test(heading))?.[1] ?? "";
    for (const para of block.paras ?? []) {
      const { name, body } = splitFeatureParagraph(para);
      if (!name) continue; // intro lines, lair prose, etc. are skipped
      items.push({
        name,
        type: "feat",
        img: "icons/svg/aura.svg",
        system: {
          description: { value: `<p>${body}</p>` },
          type: { value: "monster", subtype: "" },
          activation: act ? { type: act, value: act === "legendary" ? 1 : null } : { type: "", value: null }
        }
      });
    }
  }

  return {
    name: rec.name || rec.listName,
    type: "npc",
    img: "icons/svg/mystery-man.svg",
    system: {
      abilities,
      skills,
      attributes: {
        hp: { value: hpVal, max: hpVal, formula: hpFormula },
        ac: { flat: num(attrs["Armor Class"], 10), calc: "flat" },
        movement: parseMovement(attrs.Speed),
        senses
      },
      details: {
        cr: parseCR(tid.Challenge ?? tid.CR),
        type: { value: meta.type, subtype: meta.subtype, custom: "" },
        alignment: meta.alignment,
        source: { book: bookName }
      },
      traits: {
        size: meta.size,
        languages: { custom: String(tid.Languages ?? "").replace(/^[—–-]$/, "") },
        dr: { custom: String(tid["Damage Resistances"] ?? "") },
        di: { custom: String(tid["Damage Immunities"] ?? "") },
        dv: { custom: String(tid["Damage Vulnerabilities"] ?? "") },
        ci: { custom: String(tid["Condition Immunities"] ?? "") }
      }
    },
    prototypeToken: { name: rec.name || rec.listName, actorLink: false },
    items,
    flags: { "ddb-live-importer": { ddbId: rec.id, ddbUrl: rec.url } }
  };
}

// =============================================================================
// WHOLE BOOK -> documents per pack
// =============================================================================
/**
 * @param {object} book one entry of the ddb-books-v1 file
 * @param {string[]} typeKeys which of PACK_TYPES to build
 * @returns {Record<string, object[]>} documents keyed by pack type
 */
export function mapBook(book, typeKeys = Object.keys(PACK_TYPES)) {
  const name = book.name;
  const out = {};
  if (typeKeys.includes("monsters")) out.monsters = (book.monsters ?? []).map(r => mapMonster(r, name));
  if (typeKeys.includes("spells")) out.spells = (book.spells ?? []).map(r => mapSpell(r, name));
  if (typeKeys.includes("items")) out.items = (book.items ?? []).map(r => mapItem(r, name));
  if (typeKeys.includes("classes-feats")) {
    out["classes-feats"] = [
      ...(book.classes ?? []).flatMap(r => mapClass(r, name)),
      ...(book.feats ?? []).map(r => mapFeat(r, name))
    ];
  }
  return out;
}

/** Counts shown in the window before building. */
export function summarizeBook(book) {
  return {
    id: book.id,
    name: book.name,
    monsters: (book.monsters ?? []).length,
    spells: (book.spells ?? []).length,
    items: (book.items ?? []).length,
    classesFeats: (book.classes ?? []).length + (book.feats ?? []).length
  };
}
