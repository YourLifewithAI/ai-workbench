# RUN-13 handoff — Editing a workflow in the workbench

Branch `run/13-workflow-editing` · code at `57d39fe` · brief: `spec/runs/RUN-13.md` · decision D-62. Built here by owner decision (`spec/runs/README.md`, 2026-09-05); the coding run is parked.

## Built
- `src/runtime/workspace/workflows.ts` — the write path. `saveWorkflow` validates the draft first, refuses it with the step named, then looks at the file: a hash that moved since `baseVersion` is refused with a line diff (against the opened version when the runtime still knows it, else against the draft) and nothing is written; otherwise the file is written compacted — keys in reading order, schema defaults (`dependsOn: []`, `review: "none"`, `retries: 0`, a map's `concurrency: 3`, empty `outputs`) left out, which changes nothing the runtime hashes. `createWorkflow` (blank one-step, or a copy without its `schedule`), `deleteWorkflowFile`.
- `src/shared/workflow-check.ts` — `checkDefinition` and `describeIssues`: one verdict for the editor's live panel and the runtime's refusal, so the screen never shows a draft as saveable that the server would refuse, or the reverse. Zod issues and validator paths both come back with the step's id.
- `Runtime.saveWorkflow / createWorkflow / deleteWorkflow` — the base for a conflict diff is the in-memory copy when its hash matches, else the `workflow_versions` row; a save and a create record their hash there. Delete counts the schedule rows first and refuses with the count until told to take them too.
- Routes: `POST /workflows`, `PUT /workflows/:id`, `DELETE /workflows/:id?deleteSchedules=true`; `GET /workflows/:id` gains `schedules`. `WorkflowWriteError` maps to 400 / 404 / 409 with `details` the screen reads.
- `src/ui/screens/WorkflowEditor.tsx` — *New workflow* (the id follows the name until typed; blank or a copy) and the editor: workflow name, description, default project, inputs as rows, outputs; one `fieldset` per step (kind, agent or tool, model pin with the catalog as a datalist, input, *Only when*, review and what a rejection re-runs, where the output files, or *keep it out of the Library*); add, remove, move up, move down; a map's inner step inline. The graph is `RunGraph` over edges computed from the draft on every keystroke — template references, `when`, `over` — leniently, so it keeps drawing while a field is momentarily empty; *This draft would not run* and *Worth a look* re-run on the draft; Save is disabled while the first is non-empty. A `409` shows the diff with two lines of context and three choices: load what is on disk, save the draft over it, keep editing.
- `src/ui/screens/Workflows.tsx` — *New workflow*; on a workflow, *Edit* and *Delete…* (an inline `alertdialog` naming the schedule count); *Saved.* after a save; a file that failed to load offers *Delete…* and names the CLI command.
- `src/runtime/cli/commands/workflows.ts` — `workflows list | show <id> | new <id> --name <name> [--copy-of <id>] | edit <id> | delete <id> [--with-schedules]`. `edit` opens `$VISUAL` / `$EDITOR` (else `notepad` / `vi`), tokenised with quotes so a path with a space works, refuses a batch file on Windows by name, validates on close exactly as the loader does, leaves the file as written either way (exit 1 with the reason when it would not load), and tells a running workbench to reload.
- `Bootstrap.editor` and `Bootstrap.editorEnv` — the editor command and the child allowlist plus terminal and display variables, read in the one module allowed to read the environment.

## Not built (deliberate)
- A drag-and-drop editor or a drawn edge; workflows in the database; auto-save; a version history screen — the brief's *Do not*.
- Editing `dependsOn`, `retries`, `budget` or `outputSchema` from the form. They are preserved untouched in the file; the form is a window onto the JSON, not a replacement for it. `dependsOn` in particular is almost always implied by a reference, which is the point of D-62.
- Editing a file that failed to load. The editor needs a definition; the broken card offers Delete and names `workbench workflows edit <id>`, which is the right tool for a file that does not parse.

## Deviations from the brief
- **A refused conflict can be overridden, explicitly.** The brief says refuse and show the difference, and that neither writer silently wins. After the diff is shown the person may *Save my draft over it*; that is a decision, not a silent win, and without it the only way out of a conflict would have been to retype the draft after loading disk.
- **The screen also disables Save while the draft would not run.** The server refuses as the brief asks (DoD 2 proves that path); the screen does not make the person click to find out.
- **The `workflows` command has five verbs, not one.** `edit` is the brief's; `list`, `show`, `new` and `delete` are parity with the screen, because every screen has a command (D-45).
- **The brief cites SEC-08 for "only a human writes a definition".** In the catalog that promise is SEC-11; SEC-08 is offline mode. Amended in `sec-catalog.md`; the tests sit under SEC-11.
- **A copy leaves the schedule behind.** A schedule block seeds a row on load (D-15); copying it would silently schedule the copy.

## Verification transcript
```
npm run check                          typecheck · lint · unit 82 · security 146 · contract 51 · route-drift 79 routes · secret-scan clean
npm run dod -- 13                      8 passed (DoD 1–5, create, the CLI twice), then the two @run-13 e2e cases
npx vitest run --project dod           116 passed | 2 skipped (17 suites; the two skips are live-only)
npm run e2e                            38 passed
```
DoD 1: `final` runs on `cutter`; the editor's save moves it to `weaver` and drops the model pin; the next run's `step-started` names `weaver` and its `run-started` carries the new hash; the first run's trace still names `cutter` and the old hash. DoD 2: `{{steps.nope.output}}` in `ensemble-draft` is `400` with `step "verdict"` and `"nope"` in the message and `details.issues[0].stepId`; the bytes on disk are unchanged. DoD 3: the description edited on disk after the screen loaded, then a rename saved from the screen, is `409` with `against: 'loaded'`, the removed and added description lines in `details.conflict.diff`, and the disk edit intact. DoD 4: the validator the screen runs reports `beats → check` for the typed reference (the graph half is the e2e case). DoD 5: one schedule → `409` with `1 schedule` and `details.schedules: 1`; `?deleteSchedules=true` deletes both. CLI: an `EDITOR` script that breaks a reference exits 1 naming `nowhere` and the file keeps the break; a fixing script exits 0 with the new hash; an untouched file says `Unchanged.` e2e: New workflow as a copy → the editor → `final` to `weaver` (the graph says so) → *Add a step* → `check` on `reviewer`, root until `{{steps.beats.output}}` is typed, then `after beats` → Save → *Saved.* and a four-step graph → run → every step completed, `final (weaver)` → the trace names `weaver` and `reviewer`. Axe clean on the new, editor and delete screens.

## SEC tests added
- SEC-01, 02, 06, 11 → `tests/security/sec-11-workflow-editor.test.ts`: the three write routes 401 without the token and 403 from a foreign origin; a write under `workflows/` is denied through a whole-workspace grant; a credential typed into a step input never leaves the runtime (the response and a later GET are redacted) while the file holds what was typed.

## Spec amendments made
- `spec/ui.md` — the Workflows screen: new, edit, delete, the live graph and verdict, the conflict choices.
- `spec/api-and-cli.md` — the route table row and an amendment with the request and `details` shapes, the compacted file, and the `workflows` command.
- `spec/data-model.md` — `workflow_versions` is written by a save and a create too; `runs.workflow_version` never.
- `spec/sec-catalog.md` — the SEC-08 / SEC-11 numbering note.
- `spec/runs/README.md` — the owner's decision to build RUN-13 and RUN-14 here.

## Known gaps
- `src/ui/screens/WorkflowEditor.tsx` — the graph column is half the width on a laptop, so a four-step graph scrolls sideways inside its card. Legible, not elegant; a design pass could stack the graph above the form on medium widths.
- `src/ui/screens/WorkflowEditor.tsx` (`InputsEditor`, `OutputsEditor`) — renaming an input or output applies on blur, not per keystroke, because the name is the object key.
- A tool step's input is edited as JSON text. It is the honest shape (a tool takes arguments), but it is the one place on the screen that is not a form.

## Notes for the next run
- The verdict lives in `src/shared/workflow-check.ts` and is imported by both `src/runtime/workspace/workflows.ts` and the editor. Change it in one place.
- `WorkflowWriteError.code` → status is in `mapError` in `app.ts`; `exists` is reported as `conflict`.
- The e2e case creates `edited-in-e2e` and `delete-me-e2e` in the e2e workspace; both are temp. Nothing else in the suite names them.
- `Bootstrap` grew `editor` and `editorEnv`; `readBootstrap` is still the only reader of the environment.
- RUN-14 (the permissions review) needs nothing from here beyond `POST /workflows` if it wants to ship its workflow as a file the owner can copy; it should.

## Human verification script
1. Open **Workflows**, press **Edit** on *Research briefing*. Press **Add a step**. Set its id to `factcheck`, its agent to *reviewer*, and start typing its input: `Check every claim in this briefing.` Watch the graph: the new step sits alone. Now type `{{steps.briefing.output}}` on a new line and watch the edge from `briefing` appear before you have saved anything.
2. Under **Review** for `factcheck` choose *Wait for me before anything downstream runs*. In the `critique` step's input, replace `{{steps.briefing.output}}` with `{{steps.factcheck.output}}` and watch the graph re-route.
3. Press **Save workflow**. Expect to land on the workflow page with *Saved.* and a five-step graph. Run it on the mock (or on your key, a few cents). Expect the run to park at `factcheck` for your review.
4. Open the file in your own editor (`workbench workflows edit research-briefing` from a terminal, or any editor on the file), change the description, save. Back in the browser, still on the editor page from before? Press **Edit**, change the name, press **Save workflow**. Expect the refusal with the description line shown as changed, and the three choices.
5. On *Story pipeline*, press **Edit**, clear the **Model** field on `final` (the Gemini pin), pick an agent you hold a key for, save, run. This is the run that used to stop at step three with only an Anthropic key.
6. Press **Delete…** on a workflow that has a schedule. Expect the count in the sentence and on the button. Press **Keep it**.
