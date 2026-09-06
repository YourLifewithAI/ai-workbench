# RUN-21 — The rooms

*Draft, written with RUN-19. The owner may strike or reshape it before `run/21-rooms` exists; N-1 may be pulled forward as its own run, in which case this one only gives it a room.*

**Goal.** Inside a building there are rooms. The Library's rooms are its projects; the lodge's rooms are the agents, and an agent's room is where you edit it — on a screen, never on disk (N-1). The things a person still needs a terminal for get a room too (N-2). The owner's words: "Enter the house and you open up into the home with various rooms. Rooms can represent folders/libraries of files for various projects." And: "I want to interface only with the app itself and not with files and code in the background."

**Reads.** D-26, D-34, D-62, D-69, D-71, `ui.md` (the RUN-13, RUN-18 and RUN-19 amendments), `agents-and-prompts.md`, `spec/runs/NEXT.md` (N-1, N-2), `runlog/RUN-13.md` (forms over JSON, hash-pinned saves), `runlog/RUN-20.md`.

**Scope.**
- **The Library's rooms.** At `md` and above `/library` shows the projects as doors; `/library/:slug` is the room, its Space card and documents as today under a room header; the Interior band names the room. A figure whose run names a project stands in that room (RUN-20's place table gains the room).
- **The lodge's rooms.** `/agents` shows the agents as doors; `/agents/:id` is the agent's room: its run form as today, and **the agent editor** — forms over `agent.json` and its instruction sections, saved hash-pinned like a workflow (`PUT /agents/:id { definition, sections, baseVersion }`, 409 on a moved file with a diff), plus `POST /agents` (blank or a copy) and `DELETE /agents/:id`, and `workbench agents new|edit|delete` for parity. **`permissions` is not in the form, and a save that carries it is refused**: a grant is given on Tools and nowhere else (D-26, D-34, SEC-08).
- **The workshop's benches.** `/workflows` shows each workflow as a bench with its graph; nothing else changes.
- **N-2's rooms.** Export in the Library room (`GET /projects/:slug/export.zip`, the CLI's export as a download); a *Spend* room in the town hall (`GET /spend` by model and by subject, the CLI's table); *What is wrong* in Settings (`GET /doctor`: the CLI's checks as JSON, the same lines); the approvals history under Tools. After this run, section 1 of `docs/verification-weekend.md` is reachable without a shell, with `npm run contract -- --live` named as the one exception.

**Do not.**
- Do not let the agent editor grant, widen or unset a permission; `config/workbench.json`'s grants are byte-identical before and after any agent save (a new SEC row).
- Do not edit an agent's file by any path the editor does not take: the hash pin is the rule.
- Do not remove a CLI command: the terminal becomes optional, not absent.

**Definition of done** (`npm run dod -- 21`).
1. An agent save with a stale hash is a 409 with the current version; a good save writes the file and the next run compiles the new instructions without a restart, with a new `promptVersion`.
2. A `PUT /agents/:id` carrying `permissions` is refused by name; the grants file is byte-identical before and after every save in the suite.
3. `POST /agents` from a copy yields a loadable agent with a new id; `DELETE` removes it and its runs keep their trace.
4. The export zip holds every document's latest version and a manifest; `GET /doctor` and `workbench doctor` say the same lines; the spend room matches `workbench spend`.
5. e2e `@run-21`: every room is reachable by keyboard from its building and axe clean; an agent is edited on its room's form and the change shows in the next run's trace; a figure for a project run stands in that project's room.

**SEC.** New row **SEC-40**: an agent save never widens a grant — property-checked over the shipped agents and a fuzzed set of edits. `tests/security/sec-40-agent-editor.test.ts`.

**Human verification.** Enter the lodge, open the Weaver's room, add a sentence to its instructions, save; run it; the trace carries the sentence. Try to give it a tool from the room: there is no such control. Export a project from its room and open the zip.
