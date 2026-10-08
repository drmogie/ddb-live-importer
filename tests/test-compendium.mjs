import assert from "node:assert/strict";
import vm from "node:vm";
import {
  packNameFor, packLabelFor, parseSpellLevel, parseCastingTime, parseSpellRange, parseSpellDuration,
  parseCR, parseMonsterMeta, parseMovement, splitFeatureParagraph, mapSpell, mapMonster, mapItem,
  mapFeat, mapClass, mapBook
} from "../scripts/ddb-compendium-mapper.js";
import { buildScrapeScript } from "../scripts/ddb-compendium-scraper.js";

// pack names
assert.equal(packNameFor("Tasha’s Cauldron of Everything", "spells"), "ddb-tashas-cauldron-of-everything-spells");
assert.equal(packLabelFor("Bigby Presents: Glory of the Giants", "classes-feats"), "Bigby Presents: Glory of the Giants - Classes & Feats");
assert.match(packNameFor("x".repeat(200), "monsters"), /^[a-z0-9-]+$/);

// spell parsing
assert.equal(parseSpellLevel("Cantrip"), 0);
assert.equal(parseSpellLevel("8th"), 8);
assert.deepEqual(parseCastingTime("1 Bonus Action"), { type: "bonus", value: 1 });
assert.deepEqual(parseCastingTime("10 Minutes"), { type: "minute", value: 10 });
assert.deepEqual(parseSpellRange("Self (30-foot radius)"), { value: null, units: "self" });
assert.deepEqual(parseSpellRange("150 ft."), { value: 150, units: "ft" });
assert.deepEqual(parseSpellDuration("Instantaneous"), { value: null, units: "inst" });
assert.deepEqual(parseSpellDuration("Up to 1 Minute"), { value: 1, units: "minute" });

const spell = mapSpell({
  id: "2367", url: "/spells/2367-abi-dalzims-horrid-wilting", name: "Abi-Dalzim's Horrid Wilting",
  pairs: { Level: "8th", "Casting Time": "1 Action", "Range/Area": "150 ft.", Components: "V, S, M *", Duration: "Instantaneous" },
  tags: ["Necromancy"], materials: "a bit of sponge", html: "<p>Drains water.</p>"
}, "Xanathar's Guide to Everything");
assert.equal(spell.type, "spell");
assert.equal(spell.system.level, 8);
assert.equal(spell.system.school, "nec");
assert.deepEqual(spell.system.properties.sort(), ["material", "somatic", "vocal"]);
assert.equal(spell.system.source.book, "Xanathar's Guide to Everything");

const conc = mapSpell({ name: "Bless", pairs: { Level: "1st", "Casting Time": "1 Action", Components: "V, S", Duration: "Concentration, Up to 1 Minute" }, tags: ["Enchantment"] }, "B");
assert.ok(conc.system.properties.includes("concentration"));
assert.deepEqual(conc.system.duration, { value: 1, units: "minute" });

// monsters
assert.equal(parseCR("1/4"), 0.25);
assert.equal(parseCR("13 (10,000 XP)"), 13);
assert.deepEqual(parseMonsterMeta("Medium Humanoid (Aarakocra), Lawful Good"), { size: "med", type: "humanoid", subtype: "Aarakocra", alignment: "Lawful Good" });
assert.equal(parseMonsterMeta("Gargantuan Dragon, Chaotic Evil").size, "grg");
assert.deepEqual(parseMovement("30 ft., fly 50 ft."), { walk: 30, fly: 50, units: "ft" });
const f = splitFeatureParagraph("<p><em><strong>Dive Attack.</strong></em> If flying, deals extra damage.</p>");
assert.equal(f.name, "Dive Attack");
assert.match(f.body, /extra damage/);
const f2 = splitFeatureParagraph("<p><strong><em>Talon.</em></strong> Melee Weapon Attack.</p>");
assert.equal(f2.name, "Talon");

const mon = mapMonster({
  id: "17100", name: "Aarakocra", meta: "Medium Humanoid (Aarakocra), Lawful Good",
  attrs: { "Armor Class": "12", "Hit Points": "13 (3d8)", Speed: "20 ft., fly 50 ft." },
  abilities: { str: 10, dex: 14, con: 10, int: 11, wis: 12, cha: 11 },
  tidbits: { Skills: "Perception +5", Senses: "passive Perception 15", Languages: "Auran", Challenge: "1/4 (50 XP)" },
  blocks: [
    { heading: "", paras: ["<p><em><strong>Dive Attack.</strong></em> Extra 3 (1d6) damage.</p>"] },
    { heading: "Actions", paras: ["<p><em><strong>Talon.</strong></em> Melee, 4 (1d4+2).</p>"] }
  ]
}, "Monster Manual");
assert.equal(mon.type, "npc");
assert.equal(mon.system.attributes.hp.max, 13);
assert.equal(mon.system.attributes.hp.formula, "3d8");
assert.equal(mon.system.attributes.movement.fly, 50);
assert.equal(mon.system.details.cr, 0.25);
assert.equal(mon.system.skills.prc.value, 1);
assert.equal(mon.items.length, 2);
assert.equal(mon.items[1].system.activation.type, "action");

// items
const item = mapItem({ name: "Adamantine Armor", pairs: { Type: "Armor (medium or heavy)", Rarity: "Uncommon" }, head: "Armor, uncommon", html: "<p>Reinforced.</p>" }, "DMG");
assert.equal(item.system.rarity, "uncommon");
assert.equal(item.type, "equipment");
const wondrous = mapItem({ name: "Bag", pairs: {}, head: "Wondrous item, very rare (requires attunement)", html: "<p>x</p>" }, "DMG");
assert.equal(wondrous.system.rarity, "veryRare");
assert.equal(wondrous.system.attunement, "required");
const gear = mapItem({ name: "Abacus", pairs: { Cost: "2 gp", Weight: "2 lb." }, head: "Adventuring gear", html: "" }, "PHB");
assert.deepEqual(gear.system.price, { value: 2, denomination: "gp" });
assert.equal(gear.system.weight.value, 2);

// feats and classes
const feat = mapFeat({ name: "Alert", head: "Alert Prerequisite: None", html: "<p>Always on guard.</p>" }, "PHB");
assert.equal(feat.type, "feat");
const cls = mapClass({
  id: "2190875", name: "Barbarian", head: "Hit Point Die: D12 per Barbarian level",
  sections: [
    { heading: "Core Barbarian Traits", level: 2, paras: ["<p>Primary ability Strength</p>"] },
    { heading: "Becoming a Barbarian...", level: 3, paras: ["<p>x</p>"] },
    { heading: "Rage", level: 3, paras: ["<p>Fury.</p>"] }
  ]
}, "PHB 2024");
assert.equal(cls[0].type, "class");
assert.equal(cls[0].system.hitDice, "d12");
assert.deepEqual(cls.slice(1).map(c => c.name), ["Rage"]);

// whole book
const mapped = mapBook({ name: "Test Book", monsters: [], spells: [{ name: "A", pairs: {} }], items: [], feats: [{ name: "F" }], classes: [] });
assert.deepEqual(Object.keys(mapped).sort(), ["classes-feats", "items", "monsters", "spells"]);
assert.equal(mapped["classes-feats"].length, 1);

// the browser script must be valid JavaScript
const script = buildScrapeScript({ types: ["monsters", "spells"], titles: ["Tasha's Cauldron of Everything"] });
new vm.Script(script);
assert.match(script, /Tasha's Cauldron/);
assert.ok(script.trimEnd().endsWith('({"types":["monsters","spells"],"titles":["Tasha\'s Cauldron of Everything"],"delayMs":350});') || script.includes('"types":["monsters","spells"]'));

console.log("compendium tests passed");
