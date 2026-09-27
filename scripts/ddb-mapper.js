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

/** DDB armorTypeId -> dnd5e armor "type" bucket, used for AC calc. */
const ARMOR_TYPE = {
  1: "light",
  2: "medium",
  3: "heavy",
  4: "shield"
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
 * Best-effort AC from equipped armor. Not fully validated end-to-end yet —
 * check the actor's AC in Foundry after import.
 */
function computeAC(data, dexScore) {
  const dexMod = abilityMod(dexScore);
  const equipped = (data.inventory ?? []).filter(i => i.equipped);

  const armor = equipped.find(
    i => i.definition?.armorTypeId && i.definition.armorTypeId !== 4 && i.definition?.armorClass
  );
  const shield = equipped.find(i => i.definition?.armorTypeId === 4);

  let ac;
  if (armor) {
    const type = ARMOR_TYPE[armor.definition.armorTypeId] ?? "medium";
    const base = armor.definition.armorClass;
    if (type === "light") ac = base + dexMod;
    else if (type === "medium") ac = base + Math.min(dexMod, 2);
    else ac = base; // heavy: no dex
  } else {
    ac = 10 + dexMod; // unarmored
  }
  if (shield) ac += shield.definition?.armorClass ?? 2;

  return ac;
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

/** Very light equipment pass-through: name, quantity, equipped, weight. */
function buildGearItems(data) {
  return (data.inventory ?? []).map(i => {
    const def = i.definition ?? {};
    const isWeapon = !!def.damage || def.filterType === "Weapon";
    const isArmorPiece = !!def.armorTypeId;
    let type = "loot";
    if (isWeapon) type = "weapon";
    else if (isArmorPiece) type = "equipment";
    else if (def.isConsumable) type = "consumable";

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
  const ac = computeAC(data, scores.dex);
  const speed = data.race?.weightSpeeds?.normal ?? { walk: 30 };
  const size = SIZE_ID_MAP[data.race?.sizeId] ?? "med";

  const abilities = {};
  for (const key of ABILITY_ORDER) {
    abilities[key] = { value: scores[key] };
  }

  const actorData = {
    name: data.name,
    type: "character",
    img: data.decorations?.avatarUrl || undefined,
    system: {
      abilities,
      attributes: {
        hp: {
          value: maxHP - (data.removedHitPoints ?? 0),
          max: maxHP,
          temp: data.temporaryHitPoints ?? 0
        },
        ac: { flat: ac, calc: "flat" },
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

  const items = [...buildClassItems(data), ...buildGearItems(data)];

  return { actorData, items, raw: data };
}
