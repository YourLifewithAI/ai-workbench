# RUN-15 handoff — The catalog learns what exists

Branch `run/15-discovery` · code at `0a854bc` · brief: `spec/runs/RUN-15.md` · decisions D-64, D-65.

## Built
- `ModelAdapter.listModels?(ctx)` — optional (`src/runtime/models/adapter.ts`). Implemented for **google** (`GET /v1beta/models`, paged; only models that can `generateContent`; token limits kept, no prices stated) and **anthropic** (`GET /v1/models`, paged; ids and display names only). Both go through the injected, egress-checked fetch; both map an HTTP failure to the normalized codes (`adapters/shared/listing.ts`).
- `src/runtime/models/discovery.ts` — pure: `pinsFor()` from agent policies and workflow step overrides, `diffProvider()` → findings (new, retired with `pinnedBy`, repriced, drift), `hashFacts()` so a dismissal lapses when the provider's facts change, `applyFinding()` → the catalog a hand edit would produce, validated with `CatalogEntry.parse` before it is ever written.
- `Runtime.discover()` on every `POST /models/refresh`: asks each provider that has both a listing adapter and a credential; per-provider errors rather than one failure hiding another; offline mode is refused before any fetch is built. `acceptFinding()` writes `config/models.json` and updates the in-memory catalog in place; `dismissFinding()` records `(finding_id, facts_hash)` — migration `0012_discovery.sql`.
- **D-65** in three places: `availability.ts` (`price-unknown`, checked ahead of `no-credential`), `selection.ts` (refused by name, mock override included), `doctor` (a `pricing` check naming the entries).
- Routes `POST /models/findings/:id/accept` and `/dismiss`; `GET|POST /models` answer with `findings` and a `discovery` report. CLI `workbench models list|refresh|accept|dismiss` (the first two were documented in `api-and-cli.md` and did not exist).
- Models screen: one action, **Check for changes**; findings above the catalog with the provider's name for a model rendered as text, the pins on a retired one, accept and dismiss; a *pinned but retired* badge; *price unknown*. Both lists carry `aria-label`s.
- The mock lists what `<workspace>/fixtures/discovery/*.json` scripts for a named provider; the contract suite's new `list-models` case runs for every adapter that declares `listModels`, against authored exchanges for google and anthropic and a scripted one for the mock.

## Not built (deliberate)
- Automatic refresh on a timer — the brief forbids it, and unattended discovery is one step from unattended adoption.
- Anything that touches an agent's `modelPolicy`. A retired primary is a finding naming the agent, never a substitution (D-06, D-64).
- Inventing a price. Google states none; Anthropic states none; a discovered model arrives unpriced and unusable until a person types the number in (D-65).

## Deviations from the brief
- "A stub adapter" is the mock reading scripted listings under `--provider mock`, which is the shape every other external service already takes under that flag (D-37). It runs through the real CLI and e2e paths, which an injected stub could not.
- The button *Refresh local endpoints* became *Check for changes*: the same route, whose job grew. The `@run-02` e2e was updated for the rename and for a genuine ambiguity the findings list introduced — two lists on one screen, now both labelled and both locators scoped.
- The D-65 refusal applies under the mock override too; the brief did not say, and cost under the mock is computed from the requested id's price rows, so the hazard is identical.
- The credentials "then restart" messages in both adapters and the availability reason were false since RUN-11 and are corrected here with the same text as #24, so the two branches merge cleanly.

## Verification transcript
```
npm run check                          typecheck · lint · unit 62 · security 127 · contract 51 · route-drift 73 routes · secret-scan clean
npx vitest run --project dod           98 passed | 2 skipped (14 suites; RUN-15: 7 passed)
npm run dod -- 15                      DoD 1–6 plus the CLI case; DoD 7 is @run-15 in e2e
npm run e2e                            32 passed
```
DoD 1: three findings from a listing that adds `gemini-3.9-flash`, drops `3.6-flash` and reprices `3.8-flash`; the retired one carries `{ agentId: 'echo', role: 'fallback' }`. DoD 2: accept → `enabled: false`, `pricing: []`, the provider's stated context window kept; next refresh does not raise it; a run naming it fails `disabled`, then `no price on record`, then completes once priced. DoD 3: `price-unknown` on the screen, refused before any `model-started`, `doctor` names it. DoD 4: offline → `NetworkPolicy` per provider, `checked: []`, the injected fetch never called. DoD 5: an instruction as a display name is data in the finding, absent from the file, absent from every compiled request. DoD 6: dismissed on the same facts, raised again on new ones; 404 for an unknown finding.

## SEC tests added
- **SEC-36** (`tests/security/sec-36-discovery.test.ts`): refresh writes nothing byte-for-byte; accepting writes the id and numbers and never the provider's words; a listing carrying the workspace's own key comes back redacted (SEC-06 through this surface).
- SEC-08 re-verified: the only writes are the two routes a person clicks.

## Spec amendments made
`model-layer.md` (the optional `listModels`, the mock's scripted listings, the contract case, `price-unknown`), `ui.md` (the Models screen), `api-and-cli.md` (routes and CLI), `sec-catalog.md` (SEC-36).

## Known gaps
- The real `listModels` for google and anthropic is verified against **authored** exchanges, not recorded ones. `npm run contract -- --live google` records the real answer; the owner holds a key now.
- Google's list endpoint states token limits but no prices, and Anthropic states neither; so for these two providers discovery finds *new* and *retired* models, and *repriced* and *drift* arrive only from a provider that states them — or from a scripted listing. The brief anticipated this.
- `drift` is implemented and unit-exercised through the mock listing shape but has no DoD item of its own; the DoD 1 fixture deliberately states no capabilities so the count is exactly three.

## Notes for the next run
RUN-16 (repository tools) needs nothing from here. When RUN-17 dispatches a brief through the workbench, the first thing that run will want is a key for a second provider — and now a key is all it takes: *Check for changes* learns the models, a person accepts and prices them.

## Human verification script
1. With your Google key in Settings → Credentials, open **Models** and press **Check for changes**.
2. Expect findings against the hand-written catalog: probably several *new* models and, if any agent still pins something Google has retired, a *retired* finding that names the agent. Read them before you accept anything — that sentence is the whole point of the run.
3. Accept one *new* finding. Expect it in the catalog as *disabled* and *price unknown*; try to run an agent on it and read the refusal. Enter its price from Google's page in `config/models.json`, enable it, and run again.
4. Dismiss a finding, press *Check for changes* again, and confirm it stays silent.
5. `workbench models refresh` from a terminal, then `npm run contract -- --live google` to record Google's real listing over the authored fixture.
