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

- **2026.09.27.10** -- Renamed the right-click menu option from "Convert to
  D&D Beyond Character" to "Update D&D Beyond Character" -- same thing,
  clearer wording.
- **2026.09.27.9** -- Added the last 3 items from "Not built yet": spells,
  feats/class features/background feature as real Items, and skill/saving
  throw proficiency checkboxes.
  - **Spells** -- every spell D&D Beyond has granted (class spell lists,
    plus innate grants from race/background/magic items/feats) is now
    imported, matched against your spell compendiums the same way gear is.
    An innate grant with limited uses (like a feat's "cast once per long
    rest") carries its uses and recovery period over correctly.
  - **Feats, class features, and your background feature** are now
    imported as real Items too, matched against your feat/class-feature
    compendiums where D&D Beyond's name lines up with one (this world's
    own D&D Beyond-synced feat pack matched almost everything). See "Known
    limitation" below -- these don't carry automatic limited-use tracking
    (e.g. Second Wind won't count itself down).
  - **Skill and saving-throw proficiency checkboxes** are now set from D&D
    Beyond's data, including expertise (double proficiency) where it
    applies.
  - Re-syncing an existing character now also clears out its old spells,
    feats/features, and class item before creating the fresh set, so
    re-syncing repeatedly no longer piles up duplicates (this was a
    pre-existing gap for class items specifically -- re-syncing before this
    fix could leave a character with multiple stacked class levels).
- **2026.09.27.8** -- Fixed "Convert to D&D Beyond Character" not showing
  up on right-click. This world runs Foundry v14, which quietly changed how
  the Actor Directory's right-click menu is built: it no longer listens for
  the hook this module used to add its own entry, and it only builds that
  menu once (right when the world first loads), not fresh every time you
  right-click. Rewritten to hook in the way v14 actually supports. No
  change to the D&D Beyond side of things -- this was purely a Foundry-side
  fix.
- **2026.09.27.7** -- A few mundane items still weren't matching a real
  compendium item because D&D Beyond names them differently: "Rations (1
  day)" vs. the compendium's "Rations", "Clothes, Common" vs. "Common
  Clothes", "Rope, Hempen (50 feet)" vs. "Hempen Rope (50 ft.)". The item
  lookup now drops trailing "(...)" notes and handles D&D Beyond's reversed
  "Type, Descriptor" naming, so these match correctly too.
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
- Spells (class spell lists + innate grants from race/background/item/feat),
  matched against your spell compendiums the same way inventory items are
- Feats, class features, and your background feature, as real Items
  (matched against your feat/class-feature compendiums where a name lines
  up, otherwise a basic description-only Item)
- Skill and saving-throw proficiency checkboxes, including expertise

**Best-effort, check it after import:**
- Hit point max -- see "Known limitation" below; can come out a couple
  points low if a racial or feat Ability Score Increase was involved
- Size -- D&D Beyond doesn't document this field publicly; defaults to
  Medium if unsure
- Item name matching -- a handful of items may not match your compendiums
  by name (see above) and fall back to a basic guessed item

**Not built yet:**
- Species/racial traits as their own Items (only feats, class features,
  and the background feature are, for now)
- Automatic limited-use tracking on imported feats/class features (a
  class feature like Second Wind imports fine, but won't count its own
  uses down -- see "Known limitation" below)

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

**Known limitation -- feats/class features have no automatic limited-use
tracking.** D&D Beyond stores a class feature's uses as a flat per-level
table (e.g. "2 uses at level 3"), not a reset-period field like spells
get, so there's no reliable source to compute Foundry's recovery period
from. Set an imported feature's uses by hand on the Item if you want it
to count down (Second Wind, Action Surge, etc.).

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
