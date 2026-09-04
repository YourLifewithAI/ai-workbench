# RUN-13 — Editing a workflow in the workbench

**Goal.** The owner changes a workflow — a step's agent, its input, its model, where its output files — without leaving the UI or opening a text editor, and without ever being shown a false picture of how the steps connect.

**Reads.** `workflows-and-execution.md`, `ui.md` (Workflows), `api-and-cli.md` (`writeWorkflow`), `data-model.md`, D-62, `runlog/RUN-04.md`.

**Scope.**
- **Form-first editing.** A step is a form: agent (or tool, or `map`), input template, optional model pin, optional `when`, optional `output.document`. Add a step, remove a step, reorder. Workflow-level: name, description, `defaultProject`, the input schema's fields.
- **The graph stays read-only.** It re-renders from the edited JSON on every keystroke, so you watch the edges appear as you type a `{{steps.x.output}}` reference. That is the teaching moment of the whole screen and it is why the graph is not draggable (D-62).
- **Critiques live.** The "Worth a look" analysis already on this screen re-runs against the unsaved draft, so a step whose verdict nothing branches on is called out while you are still editing it, not after you save.
- **Validation before write.** `validateWorkflow` runs on the draft; a workflow that would not run cannot be saved. The errors name the step and the reference, as they do today.
- **The file is the truth.** Save writes `<id>.workflow.json` in the workspace and records the new content hash. If the file's hash changed since the draft was loaded, refuse the save and show what differs — the owner's editor and the workbench are both legitimate writers and neither silently wins.
- **Runs pin their hash.** A run records the workflow hash it started with and keeps it; editing never rewrites the history of a run, and a running workflow finishes on the definition it began with.
- **Create and delete.** New workflow from blank or from a copy of an existing one. Delete asks, and says how many schedules point at it.
- CLI parity: `workbench workflows edit <id>` opens `$EDITOR` on the file and validates on close.

**Do not.**
- Do not build a drag-and-drop node editor, and do not let an edge be drawn. Edges are derived from template references (D-62); a drawn edge would be a line the runtime does not read.
- Do not move workflows into the database. They are files the owner owns, like agents.
- Do not auto-save. A workflow that runs on a schedule is not a document to be half-edited.
- Do not add a version history UI for workflows; git and the owner's own backups are the history, and the content hash is what runs cite.

**Definition of done** (`npm run dod -- 13`).
1. Editing `story-pipeline`'s `final` step to a different agent, saving, and running it produces a run whose trace names the new agent; the previous run still names the old one.
2. A save that would break a reference is refused with the step and the reference named, and the file on disk is unchanged.
3. Editing the file on disk after loading the editor, then saving from the editor, is refused and shows the difference.
4. Adding a step that references `{{steps.beats.output}}` makes the edge appear in the graph before the draft is saved.
5. A workflow with a schedule cannot be deleted without the count of schedules being shown.
6. e2e: edit a step, watch the graph change, save, run, read the trace.

**SEC.** 08 (only a human writes a definition the runtime will execute), 06 (a draft is redacted like any other body).

**Human verification.** Take `research-briefing`, add a step that fact-checks the synthesis before the critique, watch the edge appear as you type the reference, save it, and run it.
