# Restyling the village

The village is the workbench's front door on a desktop (D-71): twelve buildings, one for each screen, standing
on a chunk of land. It is a picture made of data three ways, and each way is a file you can edit — or hand to
an agent with "make it cosier" and a link to this page — without touching a screen.

| Layer | File | What it decides |
|---|---|---|
| **Where** | `src/ui/village/village.json` | Which building stands on which tile, where the road and the stream run, where the trees are |
| **What** | `src/ui/village/art/index.tsx` and the files beside it | What each named piece of art looks like |
| **Colour** | `src/ui/styles.css`, the `--color-village-*` tokens | Every colour, twice: an afternoon under `@theme`, an evening under `.dark` |

Below 768px there is no village; the phone layout is untouched and lands on the Dashboard.

## The one rule

**A building is a link, and its name is its screen's name.** Nothing you change here may add text to a house,
give it a role, put a link inside it, or move a building on top of another. Those are not taste: the browser
tests read the twelve links by name, in order, with the keyboard, and the axe scans refuse a house that hides
its neighbour's middle. Everything else is yours.

## Where: `village.json`

```json
{ "screen": "/library", "art": "library", "x": 1, "y": 8 }
```

- `x` runs to the lower right, `y` to the lower left, from the back corner of the land. Tile `(0, 0)` is the far
  top; the front corner is `(11, 11)` on the shipped 12×12 grid.
- A building's feet stand on the front corner of its tile. `footprint` (default 1×1) is how many tiles it covers;
  `door` is the tile a villager stands on to be "at the door" — by default the tile in front.
- `props` are trees, pines, bushes, rocks, lamps and fence runs. `paths` and `water` are polylines over tiles:
  where a road crosses the stream, the road is drawn on top, which is a bridge.
- `places.square` is where villagers gather; `places.board` is where the town hall's notice board stands.

To move a building, change its `x` and `y`. Then run `npm run dod -- 19`: it names every problem in the file —
two buildings on one tile, one off the grid, a picture covering the middle of another, a prop in a doorway, an
art name nothing draws — and says nothing when the village is sound. `npm run check` runs the same test.

## What: the art registry

`src/ui/village/art/names.ts` lists the names the file may use; `art/index.tsx` maps each to a drawing;
`art/buildings.tsx` and `art/props.tsx` are the drawings; `art/shapes.tsx` is the kit they are drawn with — an
isometric prism, a gable and a hip roof, a window, a door, a shadow. Every drawing is a 128×128 box with the
building's feet at `(64, 118)`, so a new one lines up with the rest by construction.

To add a piece of art: add its name to `ART_NAMES`, draw it as a component in the same style, add it to `ART`.
The type checker refuses a name with no drawing. Draw with the kit and colour with `FILL` — complete class
names, never assembled from parts, because Tailwind only generates what it can read whole from the source.

What a drawing may not contain: `<title>`, `<text>`, `<desc>`, a `role`, a `tabIndex`, a link, a `data:` URL, an
external `url(…)`. The DoD reads every file in `art/` for those.

## A word about the summaries

Each screen's one-line summary lives in `src/ui/lib/screens.ts` and is shown twice on every page — in the
hover box on its building, and in the band inside the building. That makes it *global text*: a phrase you put
there appears on every screen, and can collide with a browser test that looks for that phrase somewhere else.
It happened once already — "network mode" in the Settings summary matched a check that meant the `Network
mode` label on Settings itself. If the full browser suite starts failing on a strict-mode violation after you
reword a summary, that is the cause, and rewording it again is the fix.

## Colour: the tokens

Each `--color-village-*` token in `src/ui/styles.css` appears twice — the afternoon in `@theme`, the evening in
`.dark` — and the DoD refuses one that appears once. Windows are sky by day and lamplight by night; shadows are
short by day and long by night; that is the `dark:` variants inside the drawings, not a second set of art.

To try a palette, edit the values and reload. To add a colour, add it in both blocks and to `FILL` in
`shapes.tsx`.

## Proving a change

```
npm run check                                  # the unit test on village.json, lint, types
npm run dod -- 19                              # every invariant, named
npx playwright test --grep @run-19             # the twelve links, the hover box, the keyboard, axe, both themes
```

## A checklist for an agent asked to restyle it

1. Read this page and `src/shared/village.ts` — the checks are the spec.
2. Change one layer at a time: colour, then where, then what.
3. After each change, `npm run dod -- 19` and look at `/village` in both themes at 1280px.
4. Never add text to a house; never move the phone.
5. Say in the handoff what changed in each layer and paste the DoD's last line.
