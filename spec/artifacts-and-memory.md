# Artifacts and memory

*Prose cap: 400 words. Decisions cited: D-16 … D-19, D-35.*

## Projects, documents, files, versions (D-16)

A **project** is a directory `projects/<slug>/` plus a row. It groups the work of a purpose — a briefing series, a site, a campaign, an anthology — and is the target every run names.

A **document** is text (markdown, JSON, HTML source, code) whose versions are stored in SQLite and indexed by FTS5. A **file** is anything else (images, a built site) stored on disk under `projects/<slug>/files/` and indexed by path and hash. Both are **artifacts**; both have versions.

```ts
interface ArtifactVersion {
  id: string; artifactId: string; parentVersionId?: string; hash: string;
  createdBy: 'run-step' | 'human' | 'import';
  runId?: string; stepId?: string; agentVersion?: string; modelId?: string;
  createdAt: string;
}
```

During a step, `artifact.write` stages under `runs/<id>/scratch/out/`; when the step completes, staged writes are committed as versions in one transaction. A human edit in the Library creates a version with `createdBy: 'human'`; "re-run downstream" starts the dependent steps from that version. The bible of the story example is a project document injected as knowledge, not code.

> Amendment (RUN-03, 2026-09-03): a project directory that exists on disk without a row is **adopted** on startup —
> its markdown, text and JSON files become documents with `createdBy: 'import'`. That is how `init` can ship an
> example project, and how a workspace copied between machines keeps working. Writing a body identical to the
> current version is a no-op, so a re-run that changes nothing does not inflate history.

Files have versions too (`file_versions`, `data-model.md`); export and import formats are in `data-model.md`.

## Memory (D-17)

One table, `memory_items`:

```ts
interface MemoryItem {
  id: string; scope: 'agent' | 'user' | 'workspace' | 'project'; ownerId: string;
  content: string; source: 'user' | 'agent-tool' | 'import';
  trust: 'trusted' | 'untrusted';          // untrusted if the writing run consumed external content (defined below)
  runId?: string; supersedesId?: string; createdAt: string; expiresAt?: string;
}
```

Write paths — only these: the `memory.remember({ content, scope })` tool, the Memory screen, and import. There is no automatic end-of-run extraction. **External content** is the result of `http.fetch`, `web.search`, any MCP tool, `knowledge.search` over imported files, or an `untrusted` memory item; `calc`, `datetime`, and `artifact.read` are not external. A run that has consumed external content writes `untrusted` items, and those writes are listed in the Review screen.

Read path: at context assembly the engine queries FTS5 plus recency within the scopes the agent may read, takes the top `context.memoryItems` (default 8), and stores the retrieved content in the trace as the `memory.trusted` and `memory.untrusted` sections placed next to the task (D-53). Corrections are new items with `supersedesId`; superseded items are not retrieved.

Deletion (D-35): delete removes the item; the dialog also offers "redact from the N traces that contained it", which rewrites those event payloads and records a `memory-redacted` event.

## Knowledge

Knowledge is documents. Ingestion (`workbench import knowledge <path> --project <slug>` or the Library) parses md, txt, json, csv, html, and pdf into project documents and chunks them into `documents_fts`. The `knowledge.search({ query, project? })` tool returns chunks with document and offset; at most `context.knowledgeChunks` (default 6) enter the prompt as a data section with their source, next to the task (D-53). Injecting a whole document is a deliberate per-step choice via `project.documents[...]`, not a default. If sqlite-vec is ever added (D-18), every vector row must carry its embedding model id and dimensions.
