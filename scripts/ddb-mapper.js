/**
 * ddb-mapper.js
 * ---------------------------------------------------------------------------
 * Converts a raw D&D Beyond "character/v5" JSON blob into a Foundry VTT
 * dnd5e Actor data structure (+ a small set of embedded Items for class
 * levels and equipment).
 *
 * This file is deliberately kept separate from ddb-live-importer.js so the
 * mapping logic can be tested/expanded on its own.
 *
 * SCHEMA NOTE: D&D Beyond has no public docs for this JSON shape. Everything
 * below was confirmed against a real character export on 2026-09-27
 * (character id 121878181, "Po Tato", Harengon Fighter 8 / Rune Knight).
 * Fields marked "best effort" were not fully confirmed and should be
 * sanity-checked against the console log this module prints on every import.
 * ---------------------------------------------------------------------------
 */

const MODULE_ID = "ddb-live-importer";

/** DDB stats[] / bonusStats[] / overrideStats[] are always in this order. */
const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"];

/**
 * DDB ability-score-override modifier subTypes, keyed by ability.
 * Equipped magic items (e.g. a Belt of Giant Strength) grant a "set" type
 * modifier with one of these subTypes to force an ability score to a fixed
 * value regardless of the character's rolled/bought score.
 */
const ABILITY_SET_SUBTYPES = {
  str: "strength-score",
  dex: "dexterity-score",
  con: "constitution-score",
  int: "intelligence-score",
  wis: "wisdom-score",
  cha: "charisma-score"
};

/**
 * DDB race "sizeId" -> dnd5e size code.
 * BEST EFFORT: DDB does not document this mapping. Values below are the
 * commonly-seen ids from community reverse-engineering. If an import comes
 * out the wrong size, check the console log for the raw sizeId and adjust
 * this table.
 */
const SIZE_ID_MAP = {
  1: "tiny",
  2: "sm",
  3: "med",
  4: "med", // seen on a Harengon (Small/Medium choice race) defaulting here
  5: "lg",
  6: "huge",
  7: "grg"
};

function abilityMod(score) {
  return Math.floor((score - 10) / 2);
}

function abilityForSubType(subType) {
  return Object.keys(ABILITY_SET_SUBTYPES).find(k => ABILITY_SET_SUBTYPES[k] === subType);
}

/**
 * Sum of an ability's base + bonus, then apply any character-level
 * "override" (DDB's overrideStats), then add "bonus" modifiers granted by
 * race/feat/background/class (this is how D&D Beyond stores racial and
 * feat Ability Score Increases in the 2024 rules — as separate modifiers,
 * NOT merged into stats[]), then apply any equipped item's "set" modifier
 * (e.g. Belt of Fire Giant Strength), which wins outright.
 *
 * CONFIRMED: `data.modifiers` is a top-level object keyed by source —
 * {race:[...], class:[...], background:[...], item:[...], feat:[...],
 * condition:[...]} — each entry shaped like
 * {type, subType, value, isGranted}, same shape as an item's
 * grantedModifiers. Verified against a real export on 2026-09-27.
 *
 * KNOWN GAP: D&D Beyond lists every possible Ability Score Increase choice
 * for a race/feat, not just the chosen one, and the `isGranted` flag on the
 * *unchosen* options was observed as `false` on the SAME character where the
 * chosen option should be `true` — but no `true`-flagged ability-score
 * "bonus" modifier was found for it in this session's spot check. So a
 * character's final ability scores may still come out 1-2 low if their ASI
 * was a race/feat choice rather than an item. The console log this module
 * prints has the full `data.modifiers` object — if you hit this, look for
 * the chosen ASI there and adjust the filter below.
 */
function effectiveAbilityScores(data) {
  const scores = {};
  for (let idx = 0; idx < 6; idx++) {
    const key = ABILITY_ORDER[idx];
    const base = data.stats?.[idx]?.value ?? 10;
    const bonus = data.bonusStats?.[idx]?.value ?? 0;
    const override = data.overrideStats?.[idx]?.value ?? null;
    scores[key] = override !== null ? override : base + bonus;
  }

  // Non-item "bonus" modifiers: racial ASI, feat ASI, etc. Only ones D&D
  // Beyond marks as actually granted (isGranted !== false) count.
  const modifierBuckets = ["race", "class", "background", "feat", "condition"];
  for (const bucket of modifierBuckets) {
    const mods = data.modifiers?.[bucket] ?? [];
    for (const mod of mods) {
      if (mod.type !== "bonus" || mod.isGranted === false) continue;
      const ability = abilityForSubType(mod.subType);
      if (ability && typeof mod.value === "number") {
        scores[ability] += mod.value;
      }
    }
  }

  // Equipped-item "set" modifiers (magic items that force a score).
  const equipped = (data.inventory ?? []).filter(i => i.equipped);
  for (const item of equipped) {
    const mods = item.definition?.grantedModifiers ?? [];
    for (const mod of mods) {
      if (mod.type !== "set") continue;
      const ability = abilityForSubType(mod.subType);
      if (ability && typeof mod.value === "number") {
        // Only raises the score if the item's fixed value is higher,
        // matching "has no effect if your score is already >= this" items.
        scores[ability] = Math.max(scores[ability], mod.value);
      }
    }
  }

  return scores;
}

/**
 * DDB skill-modifier subType -> dnd5e skill key. CONFIRMED against Po Tato's
 * `data.modifiers` on 2026-09-27 -- skill proficiencies show up as
 * `{type:"proficiency", subType:"<this key>"}` entries in the same flat
 * per-source buckets used for ability scores above.
 */
const SKILL_SUBTYPE_TO_KEY = {
  acrobatics: "acr",
  "animal-handling": "ani",
  arcana: "arc",
  athletics: "ath",
  deception: "dec",
  history: "his",
  insight: "ins",
  intimidation: "itm",
  investigation: "inv",
  medicine: "med",
  nature: "nat",
  perception: "prc",
  performance: "prf",
  persuasion: "per",
  religion: "rel",
  "sleight-of-hand": "slt",
  stealth: "ste",
  survival: "sur"
};

/** "constitution-saving-throws" -> "con", etc. */
function saveAbilityForSubType(subType) {
  const m = subType?.match(/^(strength|dexterity|constitution|intelligence|wisdom|charisma)-saving-throws$/);
  if (!m) return null;
  const map = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
  return map[m[1]];
}

/**
 * Skill and saving-throw proficiency checkboxes. Scans every `data.modifiers`
 * bucket (not just race/class/background/feat -- item modifiers can grant
 * proficiencies too, e.g. a set of thieves' tools proficiency from a magic
 * item) for `proficiency`/`expertise` entries, same `isGranted !== false`
 * filter as effectiveAbilityScores() above (unchosen DDB options are listed
 * with `isGranted: false` and must be skipped). `expertise` -> skill value 2,
 * `proficiency` -> skill value 1 (dnd5e: 0 none, 1 proficient, 2 expertise);
 * for saves dnd5e only has proficient 0/1, no expertise, so any hit sets 1.
 * BEST EFFORT: an "expertise" subType was never seen on Po Tato's own data
 * (he has none), so that string is assumed, not confirmed live.
 */
function buildSkillsAndSaves(data) {
  const skills = {};
  const saves = {};
  const allMods = Object.values(data.modifiers ?? {}).flat();

  for (const mod of allMods) {
    if (mod.isGranted === false) continue;
    if (mod.type !== "proficiency" && mod.type !== "expertise") continue;

    const skillKey = SKILL_SUBTYPE_TO_KEY[mod.subType];
    if (skillKey) {
      const value = mod.type === "expertise" ? 2 : 1;
      skills[skillKey] = Math.max(skills[skillKey] ?? 0, value);
      continue;
    }

    const saveAbility = saveAbilityForSubType(mod.subType);
    if (saveAbility) saves[saveAbility] = 1;
  }

  return { skills, saves };
}

/** Total character level across all classes. */
function totalLevel(data) {
  return (data.classes ?? []).reduce((sum, c) => sum + (c.level ?? 0), 0);
}

/**
 * Max HP. Confirmed formula against Po Tato:
 *   baseHitPoints (52) + conMod (3) * totalLevel (8) = 76, matches the sheet.
 * overrideHitPoints, when set, wins outright.
 */
function computeMaxHP(data, conScore) {
  if (typeof data.overrideHitPoints === "number") return data.overrideHitPoints;
  const base = data.baseHitPoints ?? 0;
  const bonus = data.bonusHitPoints ?? 0;
  return base + abilityMod(conScore) * totalLevel(data) + bonus;
}

/**
 * Build the class + subclass embedded Items (dnd5e represents level via
 * these, not a single flat field on the actor).
 */
function buildClassItems(data) {
  return (data.classes ?? []).map(c => {
    const className = c.definition?.name ?? "Class";
    const subclassName = c.subclassDefinition?.name ?? c.definition?.subclassDefinition?.name ?? null;
    return {
      name: subclassName ? `${className} (${subclassName})` : className,
      type: "class",
      system: {
        levels: c.level ?? 1,
        subclass: subclassName ?? ""
      }
    };
  });
}

/**
 * D&D Beyond "filterType" -> Foundry dnd5e Item type.
 * CONFIRMED against Po Tato's real inventory on 2026-09-27: every item has a
 * definition.filterType field. His had Weapon, Armor, Wondrous item, and
 * "Other Gear" (mundane adventuring gear -- backpack, rope, rations, etc.,
 * which dnd5e itself files under "loot", so that default is correct, not a
 * bug). Ring/Rod/Wand/Staff/Potion/Scroll/Ammunition weren't in his
 * inventory to confirm directly, but follow the same DDB category naming
 * pattern, so they're mapped by their most likely Foundry equivalent.
 */
const FILTER_TYPE_ITEM_TYPE = {
  Weapon: "weapon",
  Armor: "equipment",
  "Wondrous item": "equipment",
  Ring: "equipment",
  Rod: "equipment",
  Wand: "equipment",
  Staff: "equipment",
  Potion: "consumable",
  Scroll: "consumable",
  Ammunition: "consumable"
};

/** Best-guess Foundry item type for one inventory entry's definition. */
function guessItemType(def) {
  const mapped = FILTER_TYPE_ITEM_TYPE[def.filterType];
  if (mapped) return mapped;
  // Fallbacks for when filterType is missing or something new shows up.
  if (def.armorTypeId) return "equipment";
  if (def.damage) return "weapon";
  if (def.isConsumable) return "consumable";
  if (/tools?$/i.test(def.name ?? "")) return "tool";
  return "loot"; // matches DDB's "Other Gear" -- correct for mundane adventuring gear.
}

/** Very light equipment pass-through: name, quantity, equipped, weight. */
function buildGearItems(data) {
  return (data.inventory ?? []).map(i => {
    const def = i.definition ?? {};
    const type = guessItemType(def);

    return {
      name: def.name ?? "Unknown Item",
      type,
      img: def.avatarUrl || undefined,
      system: {
        quantity: i.quantity ?? 1,
        weight: def.weight ?? 0,
        equipped: !!i.equipped,
        attuned: !!i.isAttuned,
        rarity: (def.rarity ?? "").toLowerCase(),
        description: { value: def.description ?? "" }
      }
    };
  });
}

/**
 * D&D Beyond spell `definition.school` full name -> dnd5e school code.
 * CONFIRMED live against Foundry's own CONFIG.DND5E.spellSchools on
 * 2026-09-27 -- the 8 schools are a stable D&D concept, safe to hardcode.
 */
const SCHOOL_NAME_TO_KEY = {
  abjuration: "abj",
  conjuration: "con",
  divination: "div",
  enchantment: "enc",
  evocation: "evo",
  illusion: "ill",
  necromancy: "nec",
  transmutation: "trs"
};

/**
 * Which D&D Beyond spell bucket -> which dnd5e casting "method". `class`
 * entries come from `data.classSpells[].spells` (spells chosen off a caster
 * class's known/prepared list) and get the normal "spell" method; every
 * other bucket (race/background/item/feat) is always an innate grant in DDB,
 * matching dnd5e's "innate" method. CONFIRMED for the `feat` bucket against
 * Po Tato's real "Comprehend Languages" (from Fey Touched) on 2026-09-27;
 * the others follow the same DDB pattern but weren't separately verified
 * since Po Tato has none of them populated.
 */
const SPELL_METHOD_BY_SOURCE = {
  class: "spell",
  race: "innate",
  background: "innate",
  item: "innate",
  feat: "innate"
};

/**
 * DDB `limitedUse.resetType` -> dnd5e recovery period. CONFIRMED for `2`
 * (Long Rest) against Po Tato's real "Comprehend Languages" entry, matching
 * Fey Touched's actual rules text. `1` (Short Rest) is inferred from DDB's
 * common short=1/long=2 enum ordering seen elsewhere in this API but was NOT
 * directly confirmed this session -- if an imported spell's uses don't reset
 * on the expected rest, check the console log's raw limitedUse and adjust.
 */
const RESET_TYPE_TO_PERIOD = { 1: "sr", 2: "lr" };

/** Foundry dnd5e `system.uses` for a spell item, from a DDB entry-level `limitedUse` object. Returns undefined (unlimited use) when DDB has none. */
function buildSpellUses(limitedUse) {
  if (!limitedUse || !limitedUse.maxUses) return undefined;
  const period = RESET_TYPE_TO_PERIOD[limitedUse.resetType];
  return {
    max: String(limitedUse.maxUses),
    recovery: period ? [{ period, type: "recoverAll" }] : []
  };
}

/**
 * Every spell D&D Beyond has granted the character, from every source, deduped
 * by name (first occurrence wins -- a spell granted twice, e.g. by both a
 * class list and a feat, only needs one Item). CONFIRMED shape on
 * 2026-09-27: `data.classSpells[]` is one entry per class with a `spells[]`
 * array (empty for a non-caster like Po Tato); `data.spells` is an object
 * with `race`/`class`/`background`/`item`/`feat` bucket arrays. Every entry
 * in every bucket has the SAME shape: `{definition: {...}, limitedUse: {...}
 * | null, ...}` (entry-level `limitedUse`, not nested under `definition`).
 */
function collectDdbSpellEntries(data) {
  const seen = new Set();
  const buckets = [
    ...(data.classSpells ?? []).flatMap(cs => (cs.spells ?? []).map(entry => ({ entry, source: "class" }))),
    ...["race", "background", "item", "feat"].flatMap(source =>
      (data.spells?.[source] ?? []).map(entry => ({ entry, source }))
    )
  ];

  const out = [];
  for (const { entry, source } of buckets) {
    const name = entry.definition?.name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ entry, source });
  }
  return out;
}

/** Basic guessed spell Items, before ddb-live-importer.js swaps them for real compendium spells where a name matches. */
function buildSpellItems(data) {
  return collectDdbSpellEntries(data).map(({ entry, source }) => {
    const def = entry.definition ?? {};
    return {
      name: def.name ?? "Unknown Spell",
      type: "spell",
      system: {
        description: { value: def.description ?? "" },
        level: def.level ?? 0,
        school: SCHOOL_NAME_TO_KEY[(def.school ?? "").toLowerCase()] ?? "",
        method: SPELL_METHOD_BY_SOURCE[source] ?? "spell",
        prepared: 1,
        uses: buildSpellUses(entry.limitedUse)
      }
    };
  });
}

/**
 * Feats, class features, and the background feature, as Foundry "feat"-type
 * Items. Built directly from D&D Beyond's own name + description rather
 * than compendium-matched by ddb-live-importer.js's usual lookup, because
 * DDB's `definition.limitedUse` here is a flat per-level uses TABLE
 * (`[{level, uses}, ...]`) with no reset-period field at all -- unlike the
 * richer entry-level `limitedUse` object spells get (see buildSpellUses
 * above) -- so there is no reliable way to compute Foundry's `uses.recovery`
 * for these. KNOWN GAP: imported feats/class-features/the background
 * feature have no automatic limited-use tracking (e.g. Second Wind won't
 * count down on its own) -- check the console log's raw `classFeatures`/
 * `feats` if you need those numbers and set them by hand on the Item.
 */
function buildFeatureItem(def, typeValue) {
  return {
    name: def.name ?? "Feature",
    type: "feat",
    system: {
      description: { value: def.description ?? def.snippet ?? "" },
      requirements: def.requiredLevel ? `Level ${def.requiredLevel}` : "",
      type: { value: typeValue, subtype: "" }
    }
  };
}

/**
 * CONFIRMED shapes on 2026-09-27, all against Po Tato:
 * `data.classes[].classFeatures[]` = `{definition: {...}, levelScale}` (31
 * entries for his Fighter 8, some with `definition.hideInSheet: true` --
 * those are skipped, they're not meant to show as a separate feature);
 * `data.feats[]` = `{definition: {...}, componentId, componentTypeId}` (his
 * 7 feats); `data.background.definition.featureName` +
 * `.featureDescription` is the single background feature (Po Tato's
 * "Rune Carver" background).
 */
function buildFeatureItems(data) {
  const items = [];

  for (const cls of data.classes ?? []) {
    for (const cf of cls.classFeatures ?? []) {
      const def = cf.definition;
      if (!def || def.hideInSheet) continue;
      items.push(buildFeatureItem(def, "class"));
    }
  }

  for (const feat of data.feats ?? []) {
    if (feat.definition) items.push(buildFeatureItem(feat.definition, "feat"));
  }

  const bgName = data.background?.definition?.featureName;
  if (bgName) {
    items.push(buildFeatureItem(
      { name: bgName, description: data.background.definition.featureDescription },
      "background"
    ));
  }

  return items;
}

function buildBiography(data) {
  const parts = [];
  if (data.notes?.backstory) parts.push(data.notes.backstory);
  if (data.traits?.personalityTraits) parts.push(`<h3>Personality</h3><p>${data.traits.personalityTraits.replace(/\n/g, "<br>")}</p>`);
  if (data.traits?.ideals) parts.push(`<h3>Ideals</h3><p>${data.traits.ideals.replace(/\n/g, "<br>")}</p>`);
  if (data.traits?.bonds) parts.push(`<h3>Bonds</h3><p>${data.traits.bonds.replace(/\n/g, "<br>")}</p>`);
  if (data.traits?.flaws) parts.push(`<h3>Flaws</h3><p>${data.traits.flaws.replace(/\n/g, "<br>")}</p>`);
  return parts.join("\n");
}

/**
 * Top-level entry point. Accepts either the raw {success, data:{...}} DDB
 * response, or an already-unwrapped character object.
 */
export function mapDdbCharacterToActor(ddbResponse) {
  const data = ddbResponse?.data ?? ddbResponse;
  if (!data || !data.name) {
    throw new Error("DDBLI: unrecognized D&D Beyond character data (no name found).");
  }

  const scores = effectiveAbilityScores(data);
  const maxHP = computeMaxHP(data, scores.con);
  const speed = data.race?.weightSpeeds?.normal ?? { walk: 30 };
  const size = SIZE_ID_MAP[data.race?.sizeId] ?? "med";

  const { skills: skillProfs, saves: saveProfs } = buildSkillsAndSaves(data);

  const abilities = {};
  for (const key of ABILITY_ORDER) {
    abilities[key] = { value: scores[key] };
    if (saveProfs[key]) abilities[key].proficient = saveProfs[key];
  }

  const skills = {};
  for (const [key, value] of Object.entries(skillProfs)) {
    skills[key] = { value };
  }

  const actorData = {
    name: data.name,
    type: "character",
    img: data.decorations?.avatarUrl || undefined,
    system: {
      abilities,
      skills,
      attributes: {
        hp: {
          value: maxHP - (data.removedHitPoints ?? 0),
          max: maxHP,
          temp: data.temporaryHitPoints ?? 0
        },
        // No AC here on purpose: dnd5e computes AC itself from whichever
        // equipped item has real armor data, once ddb-live-importer.js has
        // swapped our items for real compendium items (confirmed live
        // against Po Tato on 2026-09-27 -- equip a real compendium armor
        // item and dnd5e's own "armored" formula takes over automatically,
        // no override needed). The nulls below clear any stale override
        // left by an older version of this module on a re-sync.
        ac: { flat: null, calc: null },
        movement: {
          walk: speed.walk ?? 30,
          fly: speed.fly ?? 0,
          swim: speed.swim ?? 0,
          climb: speed.climb ?? 0,
          burrow: speed.burrow ?? 0,
          units: "ft"
        }
      },
      details: {
        race: data.race?.fullName ?? "",
        background: data.background?.definition?.name ?? "",
        level: totalLevel(data),
        xp: { value: data.currentXp ?? 0 },
        gender: data.gender ?? "",
        age: data.age ? String(data.age) : "",
        biography: { value: buildBiography(data) }
      },
      traits: { size },
      currency: {
        pp: data.currencies?.pp ?? 0,
        gp: data.currencies?.gp ?? 0,
        ep: data.currencies?.ep ?? 0,
        sp: data.currencies?.sp ?? 0,
        cp: data.currencies?.cp ?? 0
      }
    },
    flags: {
      [MODULE_ID]: {
        ddbCharacterId: data.id,
        lastImported: new Date().toISOString()
      }
    }
  };

  const items = [
    ...buildClassItems(data),
    ...buildGearItems(data),
    ...buildSpellItems(data),
    ...buildFeatureItems(data)
  ];

  return { actorData, items, raw: data };
}
