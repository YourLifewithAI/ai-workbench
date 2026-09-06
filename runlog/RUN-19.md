# RUN-19 handoff — The village

**Branch:** `run/19-village` · **Head:** `a070ae0` · **Status:** awaiting verification

## Built
- `src/shared/village.ts` — the village schema, the 2:1 projection, `checkVillage` (one door per screen, art known, on the grid, no shared tile, no picture over another's middle, no prop in a doorway). Pure; UI, tests and later the CLI read it.
- `src/ui/village/village.json` — the baseline: 12×12 grid, 64×32 tiles, twelve buildings, eighteen props, four roads, one stream, the square and the board.
- `src/ui/village/art/` — `shapes.tsx` (the isometric kit: prism, gable, hip, window, door, shadow, the shared light), `buildings.tsx` (twelve), `props.tsx` (six), `names.ts`, `index.tsx` (the registry, `satisfies` over every name; `Art` takes its gradient ids from `useId`).
- `src/ui/village/Ground.tsx` — the diorama: land with earth sides, tile checker, water, roads (a road over water is a bridge).
- `src/ui/village/VillageMap.tsx` — the navigation, full (the square) and compact (the street): `li > NavLink > (Art, sr-only label)` plus a sibling `role="tooltip"` on hover/focus with Esc to dismiss; props as positioned siblings sharing the z-order.
- `src/ui/village/Interior.tsx` — the band over every screen at md+ with *Back to the village* (focus returns to the title).
- `src/ui/village/TownHallBoard.tsx`, `src/ui/screens/Village.tsx` — `/village`; below md a redirect to the Dashboard.
- `src/ui/lib/screens.ts`, `src/ui/lib/media.ts`, `src/ui/components/RunningRuns.tsx`, `CancelButton` with keys, `FrontDoor` in `App.tsx`, the Shell switch, tokens in `styles.css` (afternoon in `@theme`, evening in `.dark`).
- `docs/village.md` — how to restyle it, layer by layer, and how to prove a change.
- Tests: `tests/unit/village.test.ts` (on every check), `tests/dod/RUN-19.test.ts` (15), `tests/e2e/village.spec.ts` (4) and one case in `phone.spec.ts`.

## Not built (deliberate)
- Figures, the away board, the widened stream — RUN-20 (`spec/runs/RUN-20.md`, draft).
- Rooms, the agent editor, the terminal's rooms — RUN-21 (`spec/runs/RUN-21.md`, draft).
- Anything on a phone.

## Deviations from the brief
- The compact rail is *the street* (art only, 48px targets, the same hover box), not a scaled miniature of the square: twelve isometric buildings in a 224px column would fall under WCAG 2.2's 24×24 unobscured target.
- Pictures are 1.7 tiles wide (`ART_TILES`), up from the plan's 1.5, after looking at it; `checkVillage` still reports nothing.

## Verification transcript
```
$ npm run check
unit 116 · security 154 · contract 51 · route-drift clean (85) · secret-scan clean
$ npm run dod -- 19
Tests 15 passed (15); @run-19 e2e 5 passed
$ npm run build && npm run e2e
49 passed
```

## SEC tests added
- none: no route, tool or write was added. SEC-30 re-asserted over the built UI by DoD 4.

## Spec amendments made
- `spec/decisions.md` D-71 · `spec/ui.md` RUN-19 amendment · `spec/runs/README.md` relabel + owner decision · `spec/runs/FINISH.md` §D · `spec/runs/NEXT.md` note · `README.md`.

## Deviations, added after the first CI round
- `check (macos-latest)` failed once on the new dark-mode axe scan — `color-contrast` on
  `.text-blue-700` and `.bg-blue-700` — and nowhere else. Not a contrast defect: `transition-colors`
  animates `color` over 150ms, so immediately after the theme select the light blue is still painted on
  the dark ground. Measured: settled light `oklch(0.488 …)`, immediately after the switch
  `oklab(0.499 …)`, and the dark value `oklch(0.828 …)` only at ~340ms. axe scanned inside that window
  on that runner and read the fade. The scan now runs under reduced motion, which `styles.css` collapses
  to nothing, so what is checked is the colour at rest. Nothing was loosened or skipped.
- This is the first axe scan in dark mode in the repo; the other 43 never change theme, so none of them
  can hit it.

## Known gaps
- `src/ui/screens/Runs.tsx:23` — `useLiveRuns` still opens one stream per screen; the Shell-level hoist is RUN-20's.
- `src/runtime/api/app.ts:624` — `dashboard.running` omits `waiting_approval`; RUN-20 fixes it (the board inherits it today).
- The map's props are always painted behind a building on the same tile row; fine for the shipped layout, a z tie-break if someone plants a tree in front of a door.
- Bundle: 643 KB (+32 KB), one chunk, unchanged root of `dist/ui`.

## Notes for the next run
- The shell test reads links by `textContent`: the sr-only span must stay the link's only text node, and the tooltip must stay a sibling.
- Tailwind only generates classes it reads whole: colour through `FILL` in `shapes.tsx`, never `fill-village-${x}`.
- Every `--color-village-*` twice or DoD 3 refuses it.
- Playwright `filter({ has })` takes a page-relative locator.
- RUN-20's figures go in a second `<ul>` after the buildings so Settings stays the twelfth Tab.

## Human verification script
1. At 1280px open the workbench: the village. Hover a house: its name and what it is for; nothing written on it.
2. Enter the Library; the band names it; *Back to the village* returns you with focus on the title.
3. Theme → Dark: evening — lit windows, lamps, long shadows.
4. Shrink below 768px: the phone layout, exactly as before.
5. In `src/ui/village/village.json` move `stables` two tiles, `npm run dod -- 19`, reload: it moved. Put it on the smithy's tile: the DoD names the pair.
