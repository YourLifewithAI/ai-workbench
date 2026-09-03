# AI Workbench — Specification

This directory is the whole specification. It is written to be executed by a coding agent (or a team of them) in a series of contiguous coding runs, with a human as verifier and tastemaker.

## How to read it

**Nobody reads all of it.** A run reads exactly: `repo-root/AGENTS.md`, `STATUS.md`, `runs/README.md`, its own brief `runs/RUN-nn.md`, the previous run's handoff, the 2–6 documents the brief lists, `sec-catalog.md` for its SEC ids, and `decisions.md` for cited `D-nn`. Every document states its own prose cap at the top; schema, type, DDL blocks, and tables are excluded from caps. Caps were set before the executability dry-runs and raised where those runs showed the definitions were missing rather than the words.

Decisions live only in `decisions.md` and are cited elsewhere as `D-nn`. If a document seems to restate a principle, that is a bug — file a spec amendment.

| Document | What it settles |
|---|---|
| `vision.md` | Why this exists, who it is for, what it is not, the design tests |
| `decisions.md` | The 55 settled decisions, each with a one-line rationale |
| `architecture.md` | One process, repo layout and boundaries, workspace contract, config precedence, dependencies, platforms |
| `model-layer.md` | Canonical types, the known abstraction leaks, streaming, capabilities, errors, fallback, catalog, adapters, contract suite, mock provider |
| `agents-and-prompts.md` | `agent.json`, prompt sections, versions, tool references, import trust |
| `workflows-and-execution.md` | `.workflow.json`, DAG execution, delegate, lifecycle, budgets, cancel/resume, scheduler, review queue, approvals |
| `agent-runtime-contract.md` | What an agent sees and gets inside a step |
| `artifacts-and-memory.md` | Projects, documents, files, versions; memory; knowledge |
| `tools-and-security.md` | Threat model, security floor, tools, broker, permissions, egress and the exfiltration rule, sandbox, MCP, plugins |
| `sec-catalog.md` | The SEC test catalog; every run reads it for the ids its brief lists |
| `data-model.md` | SQLite tables, migrations, events, exports |
| `api-and-cli.md` | HTTP + SSE contract, CLI, gates, JSONL trace |
| `ui.md` | Friendly-by-design principles, screens, empty states, UX rules |
| `evaluation.md` | Compare, datasets, experiments, evaluators |
| `research.md` | The literature behind D-46 … D-59: what was adopted, what was rejected and why |
| `traceability.md` | Where each section of the original spec went |
| `runs/` | The run protocol and one brief per run (00–12; 12 is the phone run, recommended after 06) |
| `repo-root/` | Files copied verbatim to the root of the new repository at Run 00 |

## Glossary

- **Harness** — the open-source runtime + UI in this repository. Owns no user data.
- **Workspace** — the user's private directory outside the repository: agents, workflows, projects, memory, credentials, database.
- **Model** — a replaceable text/multimodal generator reached through an **adapter**. Never referenced by name outside the catalog and adapters.
- **Agent** — a declarative definition: instructions, model policy, tool references, requested permissions. No code.
- **Tool** — a typed capability an agent may call, executed by the harness through the broker under a permission policy.
- **Workflow** — a versioned DAG of steps, each running an agent or tool, possibly with a different model per step.
- **Run** — one execution of an agent or workflow; **step** — one node of it. Runs are event-sourced.
- **Project / document / file / artifact version** — where produced work lives, versioned, linked to the run and step that produced it.
- **Review** — the human rating or editing an output (quality). **Approval** — the human permitting a sensitive action (security). Different queues.
- **Evaluator** — something that scores a run: exact match, schema, rule, model-judge (an estimate), human.

## Amending the spec

Run agents may amend any document except `runs/RUN-nn.md` briefs, by appending `> Amendment (RUN-nn, YYYY-MM-DD): …` next to the changed text, in the same PR as the code that needed it. Briefs are changed only by the human. Never diverge from the spec silently.
