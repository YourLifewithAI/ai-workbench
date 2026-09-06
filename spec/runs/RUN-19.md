# RUN-19 — The village

**Goal.** The workbench's front door on a desktop is a village: one building for each screen, standing on a small floating world, entered by clicking it (D-71). The owner's words, 2026-09-06: "A cozy village. Because it takes a village to build anything worthwhile. Approachable, point and click. 2-D isometric. Each side tab is a hut/house. A baseline village that I can then modify and have an agent continue to modify aesthetically." And after the first draft: houses carry no text — the name comes up on hover — and the look is the low-poly diorama of the reference images, "more 3D than 2D".

**Reads.** `ui.md` (rules 11 and 12, the navigation table, the RUN-12 and L1–L7 amendments), D-21, D-22, D-59, D-61, D-62, D-71, `src/ui/components/RunGraph.tsx` (the precedent: SVG in the DOM, never canvas, and why), `tests/e2e/shell.spec.ts` (the keyboard contract the twelve links must keep), `tests/security/sec-30-csp.test.ts` (what the built UI may not contain).

**Why now.** The build is functionally complete and the owner has run it; what he asked for next is the look, and he decided it. Desktop first: the phone is benched, which here means untouched.

**Scope.**
- **The data.** `src/shared/village.ts`: a Zod schema for `src/ui/village/village.json` (grid, tile, buildings by screen with art name and tile, props, paths, water, places), the 2:1 projection, and `checkVillage` — one door per screen, every art name known, everything on the grid, no shared tile, no picture covering the middle of another (that middle is the pointer target WCAG 2.2 asks to be clear), no prop in a doorway. A unit test runs it on every `npm run check`, which is what makes the file safe for a person or an agent to edit.
- **The art.** An isometric shape kit and, from it, twelve buildings and six props, each an inline SVG in a 128-unit box with its feet on its tile's front corner; three lit faces, a shadow that lengthens at night, windows that light up. Every colour a `--color-village-*` token, declared twice — an afternoon under `@theme`, an evening under `.dark`. No text, no role, no link, no `data:` URL, nothing outside the bundle.
- **The map.** `VillageMap` is the primary navigation at `md` and above. Full, at `/village`, it is the square: each building an HTML link positioned over the diorama in painter's order; compact, beside every other screen, it is the street: the same twelve in a column, the current one lit. A building's only text is its screen's name, clipped from sight; a box with the name and the screen's summary opens on hover and on focus, and Esc closes it. Props sit between the buildings in the same z-order. Below `md` the Shell renders exactly what it rendered before.
- **The square's screen.** `/village`: a title, a sentence, and the town hall's notice board — the Dashboard's *Needs you* and *Running* from the same request, every running run with its budget and Cancel (ui.md §UX rules), the empty state offering *Run a workflow*. The front door `/` goes there once the welcome path is done, and to the Dashboard on a phone.
- **Inside.** An *Interior* band over every screen at `md` and above: the building's picture, its name and summary, and *Back to the village*, which returns focus to the village's title.
- **Paper.** D-71; the `ui.md` amendment; `docs/village.md`, which tells a person or an agent how to restyle it in each of the three layers and how to prove the change.

**Do not.**
- Do not put text on a house, a role on its art, or a link inside it: the shell test reads the twelve links by `textContent` and the axe scans run on every route.
- Do not render on a canvas or pull in a 3D engine (RunGraph's reason, and the CSP).
- Do not change anything a phone sees: no layout, no test, no `start_url`.
- Do not make anything move on its own (ui.md rule 12); figures that move on a run's state are RUN-20.
- Do not fetch, cache or ship an asset outside the JavaScript bundle; the service worker and SEC-30 know nothing new.

**Definition of done** (`npm run dod -- 19`).
1. `village.json` parses and `checkVillage` is empty; each invariant is proven by mutation and names the offender.
2. The buildings come in the shell's order with Settings last; the projection is 2:1; every picture lies inside the map; the gate stands furthest front.
3. Every art file is text-free and every village colour it uses is a token in both themes; every screen summary is one sentence.
4. After a build, `dist/ui` holds exactly what it held before and the village is inside the JavaScript; SEC-30's origin scan over the built UI is still clean.
5. `docs/village.md` names the three layers and the command that proves a change.
6. e2e `@run-19`: the village is the front door once the welcome path is done; every building is a link named for its screen in order, with one picture and no visible text, its box on hover and on focus, Esc closing it, twelve Tabs reaching Settings, axe clean in both themes; entering a building shows the band and the street and Back returns focus; the board shows a running run with a meter and Cancel and takes it back. On the phone: `/village` lands on the Dashboard with the tab bar, no village and no band.

**SEC.** No new row: the village adds no route, no tool and no write. SEC-30 is re-asserted over the built UI by DoD 4.

**Human verification.** At 1280px the village greets you, a floating diorama with a road and a stream. Hover a house: its name and what it is for. Enter the Library; the band names it; *Back to the village*. Switch to dark: evening — lit windows, lamps, long shadows. Shrink the window below 768px: the phone layout, untouched. In `src/ui/village/village.json` move `stables` two tiles; `npm run dod -- 19`; reload — it moved. Put it on the smithy's tile; the DoD names the pair.
