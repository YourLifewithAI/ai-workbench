# Traceability

Where each section of the original 51-section spec went. "Non-goal" entries carry their unlock trigger in `vision.md`.

| § | Original topic | Now | Runs |
|---|---|---|---|
| 0 | Role, principle, private layer | `vision.md`, `architecture.md` (workspace contract), D-24 | 00 |
| 1 | Product vision, browser as control surface, runtime outside browser | `vision.md`, `architecture.md` (process model), D-21, D-22 | 00 |
| 2 | Canonical model abstraction | `model-layer.md`, D-01 | 01, 02 |
| 3 | Technology philosophy, storage, distribution | `architecture.md`, D-18, D-22, D-23; Docker in RUN-11; desktop packaging non-goal | 00, 11 |
| 4 | Security and privacy requirements, Privacy Inspector | `tools-and-security.md` (floor, egress), `ui.md` (Runs → Inspector), D-08 data policy | 00, 02, 07 |
| 5 | Credential architecture | `tools-and-security.md` (floor), D-33; keychain is backlog | 00, 11 |
| 6 | Model interface and normalized types | `model-layer.md` (types, leaks) | 01 |
| 7 | Capability system | `model-layer.md` (capabilities), D-06 | 02 |
| 8 | Model router and policies | `model-layer.md` (selection), D-06; scored routing is a non-goal | 02 |
| 9 | Model fallbacks | `model-layer.md` (errors and fallback), D-04 | 02 |
| 10 | Agent architecture | `agents-and-prompts.md`; Workflow defined in `workflows-and-execution.md` | 01, 04 |
| 11 | Prompt system | `agents-and-prompts.md` (prompt assembly), D-09, D-10 | 01 |
| 12 | Prompt portability / compiler | Folded into adapters via `providerMeta`; no compiler (D-09) | 01 |
| 13 | Memory system | `artifacts-and-memory.md` (memory), D-17 | 08 |
| 14 | Retrieval / knowledge | `artifacts-and-memory.md` (knowledge), FTS5 first; embeddings non-goal | 08 |
| 15 | Tool architecture | `tools-and-security.md` (tools), D-25; MCP D-31 | 06, 07, 09 |
| 16 | Tool permission model | `tools-and-security.md` (permissions, broker, approvals), D-26 | 06 |
| 17 | Tool sandboxing | `tools-and-security.md` (sandbox), D-30 | 09 |
| 18 | Agent execution engine | `workflows-and-execution.md` (lifecycle), `agent-runtime-contract.md` | 00, 04 |
| 19 | Event-based execution trace | `data-model.md` (events), `api-and-cli.md` (JSONL) | 00, 01 |
| 20 | Evaluation framework | `evaluation.md`, D-36 | 10 |
| 21 | Benchmarking / experiments | `evaluation.md` (entities, results) | 10 |
| 22 | Cost and usage tracking | `model-layer.md` (usage, catalog pricing), D-08 | 01 |
| 23 | Observability / trace viewer | `ui.md` (Runs), `data-model.md` (full payloads) | 01 |
| 24 | Reproducibility | `data-model.md` (events carry payloads), D-10, D-35 | 01, 08 |
| 25 | Local-first data model, exports | `data-model.md` (exports), D-24 | 03, 11 |
| 26 | Import / export, `agents/<id>/agent.json` | `agents-and-prompts.md`, `data-model.md` (exports), D-34 | 03, 11 |
| 27 | Open-source / private boundary, repo layout | `architecture.md` (layout, workspace), D-23, D-24, D-41 | 00 |
| 28 | Plugin architecture | `tools-and-security.md` (plugins), D-32; enforced isolation non-goal | 11 |
| 29 | Model adapter requirements | `model-layer.md` (adapters), D-07 | 01, 02 |
| 30 | Browser architecture, local API, streaming | `api-and-cli.md`, D-21 | 00, 01 |
| 31 | Offline mode | `tools-and-security.md` (egress modes), `ui.md` (banner) | 02 |
| 32 | Network policy | `tools-and-security.md` (egress), D-28 | 02, 07 |
| 33 | User interface navigation | `ui.md` | 00–11 |
| 34 | Model comparison UI | `evaluation.md` (Compare), `ui.md` (Evaluate) | 10 |
| 35 | Configuration levels | `architecture.md` (precedence), D-20 | 00 |
| 36 | Error handling | `model-layer.md` (errors), D-05 | 02 |
| 37 | Resilience, retries | `model-layer.md` (fallback), `workflows-and-execution.md` (budgets, cancel, resume), D-14 | 02, 04, 05 |
| 38 | Testing strategy | `runs/README.md`, `api-and-cli.md` (gates), D-37, D-38 | 00 |
| 39 | Provider contract | `model-layer.md` (contract suite) | 01, 02 |
| 40 | Security testing | `sec-catalog.md`, D-38 | every run |
| 41 | Documentation | `spec/` itself; user docs in RUN-11 | 11 |
| 42 | Licensing | Apache-2.0, D-40 | 00 |
| 43 | Developer experience | `runs/README.md`, `repo-root/AGENTS.md`, RUN-11 DoD 1 | 00, 11 |
| 44 | Example agent (Researcher) | `research-briefing` workflow (RUN-07) and `story-pipeline` (RUN-04) | 04, 07 |
| 45 | Future architecture (multi-agent, ensembles, swarm, distributed, hardware routing) | Multi-agent and ensembles are in scope (D-11, D-12); distributed and hardware-aware routing are non-goals | 04, 06 |
| 46 | Architectural constraint / priorities | `vision.md` (design tests), `decisions.md` | — |
| 47 | MVP definition | Replaced by the run sequence; each run's DoD is the definition | 00–11 |
| 48 | Implementation method / phases | `runs/README.md` and the briefs | 00–11 |
| 49 | Deliverables A–G | A: `architecture.md`; B: `architecture.md`; C: `model-layer.md`, `agents-and-prompts.md`, `workflows-and-execution.md`, `tools-and-security.md`; D: `data-model.md`; E: `tools-and-security.md`; F: `api-and-cli.md`; G: the runs | — |
| 50 | Design test | `vision.md` (three tests) | — |
| 51 | Long-term vision | `vision.md` | — |

Dropped deliberately: the "Researcher" demo as specified (replaced by two shipped workflows), prompt compiler plugins, replaceable persistence layer, seven-type memory taxonomy, the `confidence` field, the "hallucination" metric, named routing policies, six-level configuration, calendar phases.
