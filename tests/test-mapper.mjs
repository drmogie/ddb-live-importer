import { mapDdbCharacterToActor } from "../scripts/ddb-mapper.js";

// Fixture built from the real fields confirmed against Po Tato's actual
// D&D Beyond export (character id 121878181) on 2026-09-27.
const fixture = {
  data: {
    id: 121878181,
    name: "Po Tato",
    gender: "Male",
    age: 27,
    currentXp: 900,
    baseHitPoints: 52,
    bonusHitPoints: null,
    overrideHitPoints: null,
    removedHitPoints: 0,
    temporaryHitPoints: 0,
    stats: [
      { id: 1, value: 16 }, { id: 2, value: 14 }, { id: 3, value: 15 },
      { id: 4, value: 10 }, { id: 5, value: 14 }, { id: 6, value: 8 }
    ],
    bonusStats: [{ value: null }, { value: null }, { value: null }, { value: null }, { value: null }, { value: null }],
    overrideStats: [{ value: null }, { value: null }, { value: null }, { value: null }, { value: null }, { value: null }],
    race: {
      fullName: "Harengon",
      sizeId: 4,
      weightSpeeds: { normal: { walk: 30, fly: 0, swim: 0, climb: 0, burrow: 0 } }
    },
    background: { definition: { name: "Rune Carver" } },
    classes: [
      { level: 8, definition: { name: "Fighter" }, subclassDefinition: { name: "Rune Knight" } }
    ],
    currencies: { cp: 0, sp: 0, gp: 0, ep: 0, pp: 0 },
    notes: { backstory: "Born in the waning days of autumn..." },
    traits: { personalityTraits: "Trait A\nTrait B", ideals: "", bonds: "", flaws: "" },
    decorations: { avatarUrl: "https://www.dndbeyond.com/avatars/x.jpeg" },
    inventory: [
      {
        equipped: true,
        isAttuned: true,
        quantity: 1,
        definition: {
          name: "Belt of Fire Giant Strength",
          weight: 0,
          grantedModifiers: [
            { type: "set", subType: "strength-score", value: 25 }
          ]
        }
      },
      {
        equipped: true,
        isAttuned: false,
        quantity: 1,
        definition: {
          name: "Adamantine Splint",
          weight: 60,
          armorTypeId: 3,
          armorClass: 17
        }
      },
      {
        equipped: true,
        isAttuned: false,
        quantity: 1,
        definition: {
          name: "Vicious Glaive",
          weight: 6,
          damage: { diceCount: 1, diceValue: 10 },
          damageType: "Slashing",
          filterType: "Weapon"
        }
      }
    ]
  }
};

const { actorData, items } = mapDdbCharacterToActor(fixture);

console.log("--- actorData ---");
console.log(JSON.stringify(actorData, null, 2));
console.log("--- items ---");
console.log(JSON.stringify(items, null, 2));

// Assertions against known-correct values from the real sheet, EXCEPT hp/con:
// this character's real +1 CON comes from a racial ASI choice whose exact
// "granted" representation wasn't pinned down this session (see the
// KNOWN GAP comment in ddb-mapper.js) — so con/hp here reflect what the
// fixture (base stats only, no modifiers bucket) actually produces, not the
// real sheet's 16/76. That's the documented gap, not a bug in this test.
const checks = [
  ["STR (belt override)", actorData.system.abilities.str.value, 25],
  ["DEX (base)", actorData.system.abilities.dex.value, 14],
  ["CON (base, no ASI modifier in fixture)", actorData.system.abilities.con.value, 15],
  ["HP max (52 + 2*8, base CON only)", actorData.system.attributes.hp.max, 68],
  // AC is left null on purpose so dnd5e computes it itself once a real
  // compendium armor item is equipped (see the comment in ddb-mapper.js) --
  // this assertion was stale from before that change, fixed while touching
  // this test file for the spells/feats/skills work below.
  ["AC (left null for dnd5e to compute)", actorData.system.attributes.ac.flat, null],
  ["Walk speed", actorData.system.attributes.movement.walk, 30],
  ["Level", actorData.system.details.level, 8],
  ["Size (sizeId 4 -> med)", actorData.system.traits.size, "med"]
];

let allPass = true;
for (const [label, actual, expected] of checks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> got ${actual}, expected ${expected}`);
}

// Second fixture: confirms the data.modifiers "bonus" path (racial/feat ASI)
// actually applies when D&D Beyond marks it isGranted: true, and correctly
// SKIPS an isGranted: false entry (an unchosen alternative), matching the
// real shape confirmed against Po Tato's actual modifiers.race[] array.
const asiFixture = JSON.parse(JSON.stringify(fixture));
asiFixture.data.modifiers = {
  race: [
    { type: "bonus", subType: "constitution-score", value: 1, isGranted: true },
    { type: "bonus", subType: "strength-score", value: 2, isGranted: false } // unchosen alt
  ]
};
const asiResult = mapDdbCharacterToActor(asiFixture);
const asiChecks = [
  ["CON with granted +1 ASI", asiResult.actorData.system.abilities.con.value, 16],
  ["STR unaffected by unchosen +2", asiResult.actorData.system.abilities.str.value, 25], // still belt-capped
  ["HP max with real 16 CON (52 + 3*8)", asiResult.actorData.system.attributes.hp.max, 76]
];
for (const [label, actual, expected] of asiChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> got ${actual}, expected ${expected}`);
}

// Third fixture: skills/saves proficiency, spells (an innate feat-granted
// spell with a Long Rest limited use, matching Po Tato's real "Comprehend
// Languages"/"Fey Touched"), and feats/class-features/background feature as
// items -- the "Everything (spells, feats, skills/saves)" scope.
const everythingFixture = JSON.parse(JSON.stringify(fixture));
everythingFixture.data.modifiers = {
  race: [{ type: "bonus", subType: "constitution-score", value: 1, isGranted: true }],
  class: [
    { type: "proficiency", subType: "athletics", isGranted: true },
    { type: "proficiency", subType: "acrobatics", isGranted: false }, // unchosen alt, must be skipped
    { type: "proficiency", subType: "strength-saving-throws", isGranted: true },
    { type: "proficiency", subType: "constitution-saving-throws", isGranted: true }
  ],
  feat: [{ type: "expertise", subType: "athletics", isGranted: true }] // upgrades athletics to expertise (2)
};
everythingFixture.data.classes[0].classFeatures = [
  { definition: { name: "Second Wind", description: "<p>Regain hit points.</p>", requiredLevel: 1, hideInSheet: false } },
  { definition: { name: "(hidden meta entry)", description: "", hideInSheet: true } } // must be skipped
];
everythingFixture.data.feats = [
  { definition: { name: "Fey Touched", description: "<p>Learn a divination or transmutation spell...</p>" } }
];
everythingFixture.data.background.definition.featureName = "Rune Carver's Eye";
everythingFixture.data.background.definition.featureDescription = "<p>You can spot magical runes.</p>";
everythingFixture.data.spells = {
  feat: [{
    definition: { name: "Comprehend Languages", level: 1, school: "Divination", description: "<p>Understand languages.</p>" },
    limitedUse: { maxUses: 1, resetType: 2 } // 2 = Long Rest, confirmed against the real character
  }],
  race: [], background: [], item: []
};
everythingFixture.data.classSpells = [{ entityTypeId: 1, characterClassId: 1, spells: [] }];

const everythingResult = mapDdbCharacterToActor(everythingFixture);
const spellItem = everythingResult.items.find(i => i.type === "spell");
const secondWind = everythingResult.items.find(i => i.name === "Second Wind");
const feyTouched = everythingResult.items.find(i => i.name === "Fey Touched");
const bgFeature = everythingResult.items.find(i => i.name === "Rune Carver's Eye");
const hiddenEntry = everythingResult.items.find(i => i.name === "(hidden meta entry)");

const everythingChecks = [
  ["Skill: athletics granted -> expertise (2)", everythingResult.actorData.system.skills.ath?.value, 2],
  ["Skill: acrobatics unchosen alt skipped", everythingResult.actorData.system.skills.acr, undefined],
  ["Save: STR proficient", everythingResult.actorData.system.abilities.str.proficient, 1],
  ["Save: CON proficient", everythingResult.actorData.system.abilities.con.proficient, 1],
  ["Save: DEX not proficient (untouched)", everythingResult.actorData.system.abilities.dex.proficient, undefined],
  ["Spell: name", spellItem?.name, "Comprehend Languages"],
  ["Spell: method (feat-granted -> innate)", spellItem?.system.method, "innate"],
  ["Spell: school code", spellItem?.system.school, "div"],
  ["Spell: uses.max from limitedUse", spellItem?.system.uses?.max, "1"],
  ["Spell: recovery period (resetType 2 -> long rest)", spellItem?.system.uses?.recovery?.[0]?.period, "lr"],
  ["Feature: class feature imported", secondWind?.system.type.value, "class"],
  ["Feature: hidden meta entry skipped", hiddenEntry, undefined],
  ["Feature: feat imported", feyTouched?.system.type.value, "feat"],
  ["Feature: background feature imported", bgFeature?.system.type.value, "background"]
];
for (const [label, actual, expected] of everythingChecks) {
  const pass = actual === expected;
  if (!pass) allPass = false;
  console.log(`${pass ? "PASS" : "FAIL"}: ${label} -> got ${actual}, expected ${expected}`);
}

console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
