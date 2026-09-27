# D&D Beyond Live Importer

Standalone Foundry VTT module for the GM. No other modules required, no API
token to save anywhere.

Import a character straight from your logged-in D&D Beyond account: pick a
campaign, pick a character, and it either creates a new Foundry actor or
updates the existing one if a character with that name is already there.

## How it works

Foundry can't talk to D&D Beyond's servers directly — different site, blocked
by the browser for security. So instead:

1. In Foundry, click **Import from D&D Beyond** (Actor Directory, GM only).
2. Click **Open D&D Beyond** — opens a real browser tab, already logged in as
   you.
3. Pick your campaign, then the character you want.
4. On that character's sheet page, click the **DDB Import** bookmarklet
   (one-time setup below). It copies that character's data to your
   clipboard.
5. Back in Foundry, click **Paste Character Data**.

If an actor with that exact name already exists in your world, it's updated
in place. Otherwise a new one is created.

## One-time setup: the bookmarklet

The importer dialog in Foundry has a **DDB Import** link — drag it to your
browser's bookmarks bar. That's it, one time, ever.

The bookmarklet only runs inside your own D&D Beyond browser tab, using your
own login. It reads one character's data (the same request the page itself
makes) and copies it to your clipboard. It doesn't send anything anywhere
else. Source is in `scripts/ddb-bookmarklet.source.js` if you want to read
or edit it before installing.

## What gets imported (v2026.09.27.1)

Confirmed working, from a real character export:

- Name, portrait, race, background
- Class(es), subclass(es), level
- Ability scores — including magic items that force a score (e.g. a Belt of
  Giant Strength), which D&D Beyond applies on top of the base score
- Hit points (max, current, temp)
- Speed (walk/fly/swim/climb/burrow)
- Currency (pp/gp/ep/sp/cp)
- Biography: backstory, personality, ideals, bonds, flaws
- Inventory as basic gear items (name, quantity, equipped, weight) — not yet
  fully mechanical (see below)

**Best-effort, check it after import:**
- Armor Class — calculated from equipped armor + dex, may not match every
  edge case (magic armor bonuses, special AC formulas from class features)
- Size — D&D Beyond doesn't document this field publicly; defaults to
  Medium if unsure

**Not built yet:**
- Spells
- Fully mechanical weapons/armor (attack bonus, damage dice, properties as
  Foundry activities) — items import as basic gear for now
- Feats and class features as their own Items
- Skills / saving-throw proficiency checkboxes

Every import prints the full raw D&D Beyond JSON to the browser console
(F12 → Console) along with the mapped actor data, so the mapping in
`scripts/ddb-mapper.js` can be extended without re-scraping the schema from
scratch.

## Install

1. Copy this whole `ddb-live-importer` folder into your Foundry
   `Data/modules/` folder.
2. Restart Foundry (or reload), enable **D&D Beyond Live Importer** in your
   world's module settings.
3. Do the bookmarklet setup above once.

## Versioning

`YYYY.MM.DD.#` — bump the last number for same-day changes, otherwise bump
the date.
