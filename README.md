# D&D Beyond Live Importer

Standalone Foundry VTT module for the GM. No other modules required, no API
token to save anywhere.

Import a character straight from your logged-in D&D Beyond account: pick a
campaign, pick a character, and it either creates a new Foundry actor or
updates the existing one if a character with that name is already there.

## How it works

Foundry can't talk to D&D Beyond's servers directly -- different site,
blocked by the browser for security. So instead, everything happens through
your own browser, logged in as you -- no bookmarklet, nothing to drag, no
clipboard permissions to fight with:

**New character:**
1. In Foundry, click **Import from D&D Beyond** (Actor Directory, GM only).
2. Click **Open D&D Beyond** -- opens a real browser tab, already logged in
   as you.
3. Pick your campaign, then the character you want.
4. Copy that character's link (or just the ID number in it) and paste it
   into the box in Foundry.
5. Click **Get Character JSON** -- opens the raw character data in a plain
   new tab (just a link, no script involved).
6. On that page, press **Ctrl+A** then **Ctrl+C** to copy it all.
7. Back in Foundry, click into the text box, press **Ctrl+V**, then click
   **Import Character**.

If an actor with that exact name already exists in your world, it's updated
in place. Otherwise a new one is created.

**Re-syncing a character you already imported:**
1. Right-click that actor in the Actor Directory.
2. Pick **Convert to D&D Beyond Character**. The character ID box is already
   filled in from last time.
3. Click **Get Character JSON**, copy it (Ctrl+A, Ctrl+C), come back, paste
   it (Ctrl+V) into the box, and click **Import Character**. That one actor
   is updated, no name matching needed.

## Changelog

- **2026.09.27.6** -- Two accuracy changes:
  - **Real items instead of guesses.** Every inventory item (including
    magic items) is now looked up by name in your Foundry item
    compendiums (`dnd5e.items`, `dnd5e.equipment24`, and any
    world-specific item pack) and the real item is attached to the
    character -- correct damage dice, armor values, weight, properties,
    everything -- instead of this module guessing at a basic item. If an
    item's name doesn't match anything in your compendiums (homebrew, or
    a naming mismatch like "Rope, Hempen (50 feet)" vs. a compendium's
    "Hempen Rope (50 ft.)"), it falls back to the old basic-item guess, so
    nothing is ever left out.
  - **AC is now computed by Foundry itself**, not this module. Once a real
    compendium armor item is attached and equipped (see above), the dnd5e
    system detects it and calculates AC on its own, the same way it would
    for a hand-built character. This module no longer writes an AC number
    at all.
- **2026.09.27.5** -- Item types now use D&D Beyond's own category field
  instead of guessing, fixing items (including significant magic items)
  that were all showing up as generic "Loot."
- **2026.09.27.4** -- Fixed the "Paste Character Data" step always failing
  with "Couldn't read the clipboard." Foundry servers reached over plain
  http:// (no TLS, e.g. a LAN IP) are not a "secure context," and Chrome
  blocks JavaScript from reading the clipboard at all on such pages -- no
  fix on this module's side could work around that. Replaced the
  clipboard-read step with a plain paste box: copy the JSON (Ctrl+A,
  Ctrl+C) same as before, then click into the box in Foundry and press
  Ctrl+V, which is a normal browser paste with no permission involved.
- **2026.09.27.3** -- Dropped the bookmarklet entirely (dragging it to the
  bookmarks bar wasn't working reliably). Replaced it with a plain "paste
  the character's URL or ID, then open+copy its JSON" flow -- no script
  ever runs on D&D Beyond's page. Added a right-click **Convert to D&D
  Beyond Character** option on existing actors, which remembers the
  character ID for a quick re-sync next time.
- **2026.09.27.2** -- Fixed the "Import from D&D Beyond" button never
  appearing in the Actor Directory. Foundry v13+ changed core Applications
  to a new framework (ApplicationV2) that hands modules a plain HTML
  element instead of the old jQuery object; the button code was still
  using the jQuery-only `.find()`, which threw an error every time
  (visible in the browser console as `html.find is not a function`) before
  the button could be added. Rewritten against the current ApplicationV2
  API.
- **2026.09.27.1** -- Initial version.

## What gets imported

Confirmed working, from a real character export:

- Name, portrait, race, background
- Class(es), subclass(es), level
- Ability scores -- including magic items that force a score (e.g. a Belt
  of Giant Strength), which D&D Beyond applies on top of the base score
- Hit points (max, current, temp) -- computed by this module (see below)
- Armor Class -- computed by Foundry itself from your equipped armor item
- Speed (walk/fly/swim/climb/burrow)
- Currency (pp/gp/ep/sp/cp)
- Biography: backstory, personality, ideals, bonds, flaws
- Inventory as real Foundry items where a compendium match is found
  (correct damage, armor, properties, magic items included), otherwise a
  basic gear item as a fallback

**Best-effort, check it after import:**
- Hit point max -- see "Known limitation" below; can come out a couple
  points low if a racial or feat Ability Score Increase was involved
- Size -- D&D Beyond doesn't document this field publicly; defaults to
  Medium if unsure
- Item name matching -- a handful of items may not match your compendiums
  by name (see above) and fall back to a basic guessed item

**Not built yet:**
- Spells
- Feats and class features as their own Items
- Skills / saving-throw proficiency checkboxes

**Known limitation -- HP max is still computed by this module, not
Foundry.** AC (as of 2026.09.27.6) is handed off to Foundry's own
calculation once a real armor item is attached. HP can't work the same way:
Foundry's dnd5e system only derives max HP from hit dice + CON through its
interactive level-up wizard, not automatically for a bulk-imported
character, so this module still computes it directly (base HP + CON mod x
level). The real fix for HP accuracy is getting the CON score exactly
right -- D&D Beyond lists every possible Ability Score Increase choice for
a race/feat, not just the one actually picked, which can make CON (and so
HP) come out 1-2 low. Every import prints D&D Beyond's raw `modifiers` data
to the console so this can be tracked down further.

Every import prints the full raw D&D Beyond JSON to the browser console
(F12 -> Console) along with the mapped actor data, so the mapping in
`scripts/ddb-mapper.js` can be extended without re-scraping the schema from
scratch.

## Install

1. Copy this whole `ddb-live-importer` folder into your Foundry
   `Data/modules/` folder.
2. Restart Foundry (or reload), enable **D&D Beyond Live Importer** in your
   world's module settings.

## Versioning

`YYYY.MM.DD.#` -- bump the last number for same-day changes, otherwise bump
the date.
