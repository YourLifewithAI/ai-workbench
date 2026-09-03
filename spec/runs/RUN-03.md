# RUN-03 — Projects, documents, files: the Library

**Goal.** Every run's output lands somewhere durable, versioned, editable, and exportable. The work product gets its home before workflows multiply it.

**Reads.** `artifacts-and-memory.md` (artifacts), `data-model.md`, `api-and-cli.md` (projects, documents, export/import routes), `agents-and-prompts.md` (`output`, `documents`), `ui.md` (Library), `runlog/RUN-02.md`.

**Scope.**
- `projects, documents, document_versions, documents_fts, files, file_versions` tables; project directories; run staging under `runs/<id>/scratch/out/` committed as versions on step completion; `artifact.read/write/list` as engine-internal capabilities (not yet exposed as agent tools); agent `output.kind = 'document'`.
- Human edit → version with `createdBy: 'human'`; diff view; project export and import per `data-model.md` with redaction manifest.
- Move the story bible to `examples/workspace/projects/anthology/bible.md`, injected through each story agent's `documents: ["bible.md"]` as the `knowledge` section; agent `output.document` paths; run form gains "target project".
- Library screen.

**Do not.** Add workflows, external tools, memory search, scheduler, knowledge ingestion of arbitrary files.

**Definition of done** (`npm run dod -- 03`).
1. `workbench run agent architect --input "<premise>" --project anthology --provider mock` creates document version 1 linked to run, step, agent version, model id.
2. Editing that document in the Library creates version 2 with `createdBy: human`; the diff renders.
3. `workbench export project anthology --out /tmp/x` produces documents, `files/`, and a `manifest.json` that validates; `workbench import project /tmp/x` into a fresh workspace recreates it.
4. e2e covers create, edit, diff, export.

**SEC.** 26; 06 re-run with a document that contains a registered secret (absent from the export, listed in the manifest as redacted).

**Human verification.** Run Architect into the anthology project, open the Library, edit the beats by hand, see two versions and a diff, export the project and look at the folder.
