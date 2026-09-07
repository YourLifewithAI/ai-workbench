# RUN-22 — The village in three dimensions

*Draft, written after the owner saw RUN-19 against a reference image. He may strike or reshape it before
`run/22-diorama` exists. It is queued behind RUN-21: the rooms are what he needs, this is what he wants.*

**Goal.** The village becomes a lit diorama rather than a drawing of one. The owner's words:

> "Can we do a 3D diorama and just have the lighting change based on the time of day? Then the 3D
> representations for each object in the diorama stay static but the lighting itself changes."

That is the design, and it solves a problem the alternatives could not. Pre-rendered sprites would need two
complete image sets, an afternoon and an evening, and would put the art beyond reach of a text edit. **One set
of geometry, lit two ways, needs neither.** The evening stops being a second drawing and becomes a lower sun.

**Reads.** D-21, D-61, D-62, D-71 (and its amendment, below), `ui.md` §Navigation and the RUN-19 amendment,
`docs/village.md`, `src/shared/village.ts`, `src/ui/village/art/shapes.tsx`, `runlog/RUN-19.md`,
`tests/dod/RUN-19.test.ts` lines 109-137 and 157-165 — those four assertions shape the whole design.

## The resolution of D-71

D-71 refused a canvas because it would take the twelve links out of the accessibility tree — `RunGraph`'s
reason. That objection is answered rather than overridden, and the amendment must say so plainly:

> **The canvas draws the picture; the DOM keeps the links.** The links never enter the canvas. They are the
> same twelve `NavLink`s, over a decorative `aria-hidden` canvas, with the same names, tooltips, keyboard
> order and z-index. What the canvas buys is the one thing vector could only imitate: geometry lit two ways.

And the detail that makes it cheap: **each link keeps its `<svg>` mounted, hidden with `display:none` once the
first WebGL frame lands.** Not an empty transparent box. That single choice means `village.spec.ts:38` — one
`aria-hidden` svg per link — passes *unchanged*, the no-WebGL fallback is a CSS toggle rather than a second
code path, and context loss on sleep/wake recovers by un-hiding.

## Scope

- **Geometry as code.** `RUN-19.test.ts:159` allows only `.js`/`.css` under `dist/ui/assets`, so no `.glb`,
  no texture, no `data:` URI — and that constraint is a gift: it keeps the art restyleable as text. Buildings
  are a `Record<ArtName, Part[]>` of `box` / `gable` / `hip` / `panel` / `revolve` in tile units. The current
  kit is *hand-projected 3D already* — `along()` is a projection matrix applied at author time — so the port
  mostly deletes arithmetic. `shapes.tsx` itself is untouched: it still serves the street and the interior band.
- **`src/shared/village.ts` stays byte-identical, and the camera is fitted to it** — never the reverse.
  `buildingBox` is not layout, it is the WCAG target-size invariant `checkVillage` enforces; it must not become
  a function of a renderer. The projection is a closed-form orthographic camera reproducing `project()` exactly,
  so agreement is analytic rather than maintained. The canvas is a viewBox, not a viewport: container width and
  device pixel ratio change the drawing buffer and never the projection.
- **The light is the theme.** The 28 `--color-village-*` tokens stay as albedo; a small set of new `--village-*`
  properties carries the sun's azimuth, elevation, key and bounce colour, ambient strength, window emissive and
  shadow opacity, in `:root` and `.dark`. A theme change writes **uniforms only** — never the vertex buffer.
  Shadows stop being `cast(10)` and `cast(34)` chosen by hand and become the footprint projected along the sun.
- **Rendering discipline.** No animation loop. One frame at mount, and another only on a theme change, a
  resize, a DPR change, a route change (the active building's glow) or, later, a villager moving. D-71's
  "nothing moves on its own" becomes a gate, not a promise.
- **Off the phone and off eleven routes.** A `React.lazy` chunk, requested only by the square at ≥768px. A
  hand-rolled renderer is ~5KB gzip; three.js would be ~140KB and must be measured against `sec-30-csp.test.ts`,
  which scans built JS for URLs and would meet three.js's error-message links. Start hand-rolled.
- **Split if it grows.** RUN-22 is the twelve buildings over the existing SVG ground — both share a viewBox, so
  it composites. The props, the ground, the roads and the stream can be RUN-23 rather than one enormous run.

## Do not

- Do not put the links inside the canvas, or give the canvas a role, a name or a tabindex.
- Do not delete the SVG art. It is the street (`Shell.tsx`), the interior band, and every machine without a GPU.
- Do not change `src/shared/village.ts`. If the geometry wants a different box, the geometry is wrong.
- Do not ship a model file, a texture or a `data:` URI. Geometry is code.
- Do not start a `requestAnimationFrame` loop, and do not re-upload the vertex buffer to change the light.
- Do not cross-fade the theme. A 150ms colour transition already cost a run once (`village.spec.ts:75-83`).
- Do not make the phone carry any of it.

## Before any of it: the twenty-minute spike

Two questions decide whether this run is possible, and both are answerable without writing village code.

1. **Does axe accept a canvas under the links?** Put a bare grey `aria-hidden` canvas behind them and run
   `--grep @run-19`. If the twelve scans stay green, the architecture is proven for half an hour's work. If
   not, the run dies there and nothing was built.
2. **Does CI actually see WebGL?** Chromium 141 — the pinned browser — refuses the software fallback without
   `--enable-unsafe-swiftshader`. Without that flag, `getContext('webgl2')` returns null on the Linux and
   Windows runners, the SVG fallback engages, and **every assertion passes while testing nothing**, green on
   macOS for the real path and green elsewhere for the wrong one. Add the flag in `playwright.config.ts`, log
   `UNMASKED_RENDERER_WEBGL`, and add a case that stubs `getContext` to null so the fallback is still covered.

## Definition of done (`npm run dod -- 22`)

1. The camera reproduces `project()` to nine decimal places at every tile of the grid.
2. Every building's silhouette, projected, is contained within its own `buildingBox` — so `checkVillage`'s
   "covers a neighbour's middle" rule stays sufficient, and a building drawn too tall fails by name.
3. In the browser, each link's rendered centre and its DOM box centre agree within 1.5px, at two viewport
   widths and at DPR 2.
4. One frame at rest and one more after a theme change, with the geometry uploaded exactly once — the owner's
   "static geometry, changing light" as an assertion.
5. With WebGL stubbed out, the twelve links, their order, their names and a clean axe scan all survive.
6. Every `--village-*` light property exists in both `:root` and `.dark`, checked the way the colours are.
7. The 3D and SVG registries cover exactly the same `ART_NAMES`, so adding a building to one and not the other
   fails by name.

## Amendments this run must make

D-71 in `spec/decisions.md` — it currently says "not a canvas, for RunGraph's reason" and "pre-shaded vector
rather than a 3D engine". Amend it in the same PR, stating what changed and why the original reason no longer
binds, and carry forward unchanged the clauses that still do: no external asset, nothing the CSP or the shell
worker must learn, nothing moves on its own, nothing the phone carries. `docs/village.md` gains a fourth layer,
**Light**, and a row saying which art source serves the square and which serves the street.

## Human verification

At 1280px the village is a lit model: soft shadows, a sky behind the island, houses that read as objects rather
than as shapes. Switch the theme — the sun drops, the windows come on, the shadows lengthen, and nothing else
moves. Edit `--village-sun-elevation` and reload: the shadows follow. Move a building in `village.json` and
reload: it moves, and its hover box moves with it. Open it on a machine with no GPU: the drawing is back, and
every link still works.
