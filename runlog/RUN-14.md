# RUN-14 handoff — The standing permissions review

Branch `run/14-permissions-review` · code at `288da01` · brief: `spec/runs/RUN-14.md` · decision D-63. Built here by owner decision (`spec/runs/README.md`); branched from `run/13-workflow-editing`, so it lands after RUN-13.

## Built
- `src/runtime/permissions/review.ts` — the facts and the arithmetic. `gatherFacts` reads grant metadata only: every grant with *since when* (the `grant_log` row that set it, else the workspace's creation) and how many times `tool_calls` shows it exercised; every approval attributed to its agent with the streak of allows since the last denial; the hosts each agent's tools reached (`egress_log` joined to `tool_calls`, model calls excluded) against the hosts its grant admits; tools nobody has granted or denied, and who asks for them; each agent's instructions (not a trace). `candidateFindings` turns the numbers into candidates — `unused`, `reach`, `fatigue`, `undecided` — each with a headline, evidence lines, a proposal in the matrix's terms and a hash of the facts it rests on; `unjustifiedCandidate` is the one the auditor may raise on its own reading. `briefOf` is what the auditor is shown: candidates first, then numbers, then a slice of each agent's instructions, sized to survive the tool-result cut (D-47). `applyProposal` is pure.
- `src/runtime/permissions/store.ts` — `FindingStore`: raise (suppressed when dismissed on the same facts, merged into the open row when one exists), list, decide; `logGrantChange`, one `grant_log` row per field that moved, always `source: human`.
- `src/runtime/permissions/propose.ts` — what the auditor chose, by candidate id or as an `unjustified` finding of its own; anything it cannot point at is ignored by name and reported back.
- `src/runtime/tools/builtin/permissions.ts` — `permissions.facts` (read tier) and `permissions.propose` (write tier), both with empty `maxPermissions`, no credentials, no network. The facts a run was shown are kept by run id, so `propose` judges against the candidates the auditor saw at the thresholds it asked for.
- `Runtime.setGrant` now logs; `permissionFacts`, `decideFinding` (apply is `setGrant` through `applyProposal`; dismiss records the facts hash); `recordCatalogSeen` at start. Migration `0013`: `grant_log`, `permission_findings`, `permission_finding_dismissals`, `tool_catalog_seen`.
- Routes `GET /permissions/findings`, `POST /permissions/findings/:id`; CLI `workbench review findings list | apply | dismiss`.
- `src/ui/screens/Review.tsx` — a *Permissions review* section above the queue: headline, evidence, the auditor's note, one button that says what it does, Dismiss.
- `examples/workspace/agents/auditor/` (the smallest permissions row in the workspace: the two tools), `workflows/permissions-review.workflow.json` (facts → audit → file; weekly on Monday, seeded **paused**), `fixtures/auditor.json` for the mock, the auditor's grant in `config/workbench.json`.
- `Workflow.schedule.enabled` (default true) and the scheduler seeding it.

## Not built (deliberate)
- Any code path by which a run writes the matrix — the brief's *Do not*, D-63, SEC-37. There is no tool for it; `permissions.propose` files rows the person decides.
- Auto-applying "safe" revocations. Every change is a click.
- The review on by default. Its schedule row is seeded paused.
- Content reads for the auditor. When the `unjustified` judgement seems to need a trace, the finding is out of scope, and the agent's grant makes that a fact rather than a rule.

## Deviations from the brief
- **The evidence is the runtime's, not the model's.** The brief's findings are "rows with the evidence that produced it"; here the auditor raises a *candidate* by id (or an `unjustified` one by agent and tool) and adds a note, while the headline, the numbers and the proposal come from `candidateFindings`. A model cannot argue a finding into existence, and the mock can stand in for it in tests without the tests proving nothing.
- **The auditor is shown a brief, not the facts.** The facts for the shipped workspace are ~34 KB; a tool result is cut at 8 000 characters (D-47), and the first version lost every candidate to the cut. The brief puts candidates first so a large workspace loses instruction text, never a finding; DoD asserts the shipped brief fits.
- **`undecided` is per agent that asks.** A tool nobody asks for is listed in the facts for the auditor to mention, not raised as a card: twenty informational cards on the first review is the nagging the brief warns against.
- **`grant_log` and `tool_catalog_seen` are new tables.** "When each grant was made" and "new tool" had no source of truth; the brief assumed one.
- **Fatigue proposes what the matrix can do.** A tool that asks by design, or one the agent's own file demands an approval for, gets a finding with no button and a sentence saying why.
- **`schedule.enabled`** did not exist; "disabled until the owner enables it" needed it. Amended in `workflows-and-execution.md`.
- **SEC numbering.** The brief cites SEC-08; the promise is SEC-11, and the new row is SEC-37.

## Verification transcript
```
npm run check                          typecheck · lint · unit 89 · security 150 · contract 51 · route-drift 81 routes · secret-scan clean
npm run dod -- 14                      7 passed (the paused seed, the brief's size, DoD 1–5), then the @run-14 e2e cases
npx vitest run --project dod           123 passed | 2 skipped (18 suites; the two skips are live-only)
npm run e2e                            39 passed
```
DoD 1: a `grant_log` row forty days old for `researcher` / `http.fetch` and no call → `permissionFacts()` lists `unused:researcher:http.fetch` with `ageDays: 40, uses: 0`; the scripted auditor raises it; exactly one open finding, headline `researcher holds http.fetch and has never used it.`, evidence `Granted 40 days ago, on 2026-07-27.` and `Exercised 0 times in that time.`, proposal *Take back http.fetch from researcher*. DoD 2: apply → the matrix cell reads `unset`, `config/workbench.json` agrees, `grant_log` holds `"allow" → null, human`; the re-run raises nothing and the candidate is gone. DoD 3: the Weaver granted `artifact.write` with `approvalRequired`, three approved runs → `fatigue:weaver:artifact.write` at `fatigueStreak: 3`, proposal *Stop asking before weaver uses artifact.write*; dismiss → the re-run reports `suppressed: 1` and nothing open; one more approval → a new finding, `4 times in a row`. DoD 4: the auditor's row is the two tools; its run's `tool-requested` events are exactly those two. DoD 5: a review run leaves the config byte-for-byte; every `grant_log` source is `human`; no catalogue id matches `grant`. e2e: the mock review lands two `unjustified` findings; *Take back memory.remember from reviewer* flips the cell to `unset` and the card goes; Dismiss on the other changes nothing but the queue. Axe clean on Review with findings.

## SEC tests added
- SEC-37 → `tests/security/sec-37-permissions-review.test.ts`: the auditor's grant and its tools' `maxPermissions`; a review run's tool calls; no grant-setting tool; the finding routes 401 without the token and 403 from a foreign origin; a review run leaves `config/workbench.json` and `grant_log` untouched.

## Spec amendments made
- `spec/ui.md` — the Review screen's *Permissions review* section; the paused schedule on Workflows.
- `spec/api-and-cli.md` — the route table row and an amendment with the shapes, the two tools, the CLI, `schedule.enabled`.
- `spec/data-model.md` — the four tables, migration `0013`.
- `spec/sec-catalog.md` — SEC-37 and the numbering note.
- `spec/workflows-and-execution.md` — `schedule.enabled`.

## Known gaps
- `src/runtime/permissions/review.ts` — approvals are attributed to an agent through the `tool_calls` row for the same run and step; a step that raised an approval and then never recorded a call (a cancelled run) attributes to the run's agent, which is null for a workflow run. Such approvals appear in the facts with `agentId: null` and raise nothing.
- The `reach` finding compares hosts against `net.allow` patterns with the egress checker's wildcard rule re-stated here; if that rule grows, this copy has to follow.
- `briefOf` trims each agent's instructions to 260 characters. Enough for "does this agent ever mention the web"; not enough for a subtle case. A bigger budget needs the tool-result cut raised in `config/workbench.json` (`context.maxToolResultChars`).

## Notes for the next run
- The auditor's judgement only matters on a real model. With the mock, `fixtures/auditor.json` raises two `unjustified` findings; tests that need a specific candidate script one with `lastUserIncludes: '<candidate id>'`, which works because the brief carries the ids.
- `factsByRun` in `Runtime.create` is what lets `propose` see the candidates the auditor saw; it is cleared on propose.
- A dismissal is by `key` (`kind:agent:tool`) and facts hash; applying clears any dismissal on that key.

## Human verification script
1. Open **Workflows** → *Permissions review*. Its schedule is paused; leave it so for now and press **Start run** with the mock ticked. Expect two findings on **Review** under *Permissions review* (the mock's reading of the Researcher and the Reviewer).
2. Read one card: the headline and the evidence lines are the runtime's; the line beginning *The auditor adds* is the model's. Press the button on one. Expect the card to go, and on **Tools** the cell for that agent and tool to read *unset*.
3. Press **Dismiss** on the other. Run the workflow again. Expect nothing new: the dismissal holds while the facts are the same.
4. When you have a fortnight of real use: enable the schedule, or run it on your key (a few cents; it reads a few kilobytes and answers a short JSON). Read the findings against the grants you had already half-decided to take back. That match, or its absence, is the run's real verification.
