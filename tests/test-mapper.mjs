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
  ["AC (heavy armor, no dex)", actorData.system.attributes.ac.flat, 17],
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

console.log(allPass ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
