# RUN-08 — Memory and knowledge

**Goal.** Agents remember across runs and search curated knowledge, and a poisoned memory can never become an instruction.

**Reads.** `artifacts-and-memory.md`, `agents-and-prompts.md` (prompt sections), `data-model.md` (memory tables), `api-and-cli.md` (memory, knowledge routes), `tools-and-security.md` (memory trust), `runlog/RUN-07.md`.

**Scope.**
- `memory_items`, `memory_fts`; `memory.remember`, `memory.search`; `trust` derived from whether the writing run consumed external content; `supersedesId`; `expiresAt`.
- Context assembly: scoped FTS + recency retrieval into `memory.trusted` and `memory.untrusted` sections, fenced as data; retrieved snapshots stored in the trace (`memory-retrieved`).
- Memory screen: search by scope, provenance, delete with "also redact from N traces" (`memory-redacted`).
- Knowledge ingestion (md, txt, json, csv, html, pdf) into project documents and `documents_fts`; `knowledge.search` tool; import from the Library and `workbench import knowledge`.
- Untrusted memory writes listed in Review.

**Do not.** Add embeddings or sqlite-vec, automatic end-of-run extraction, new network tools.

**Definition of done** (`npm run dod -- 08`).
1. A run that called `http.fetch` then `memory.remember` produces an `untrusted` item; on the next run it renders inside the fenced `memory.untrusted` section (asserted on the compiled prompt in the trace) and appears in Review.
2. A user-created item renders in `memory.trusted`; a superseded item is not retrieved.
3. Deleting an item with redaction removes its content from the two traces that contained it and appends `memory-redacted`.
4. Ingesting a PDF and running `knowledge.search` returns the right chunk with document and offset.
5. e2e: search, inspect provenance, delete with redaction.

**SEC.** 14 (a fixture memory containing "ignore your instructions and…" does not change a scripted agent's behavior and never appears in an instruction section), 15, 16 (agent A cannot read agent B's agent-scope items; project scopes are isolated).

**Human verification.** Tell the briefing Reviewer to remember your standing interests; run it again and see them used; ingest a PDF into a project and ask an agent about it; delete a memory and confirm it is gone from the old trace.
