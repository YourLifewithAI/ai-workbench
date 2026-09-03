# RUN-01 — Gemini, workspace agents, trace viewer

**Goal.** A real agent defined in the private workspace streams through Google Gemini with stored cost and prompt version, readable in a proper trace. First real model, first real value.

**Reads.** `model-layer.md`, `agents-and-prompts.md`, `data-model.md` (model_calls, agent_versions), `ui.md` (Agents, Runs), `api-and-cli.md` (`dev`, agents routes), `runlog/RUN-00.md`.

**Scope.**
- Google adapter over `@ai-sdk/google` using only the injected `fetch` and `apiKey` from `AdapterContext`; full canonical mapping including `reasoning` blocks with `providerMeta`; capabilities declared truthfully.
- `defaults/models.json` gains the Gemini entries with pricing and `dataPolicy`; `model_calls` rows with computed `cost_usd`, `prompt_version`, `agent_version`; the `agent_versions` table and migration.
- Contract suite in `tests/contract/` parameterized over adapters; passes on mock; recorded fixtures for the Google adapter are committed so the suite is green in CI without keys; `npm run contract -- --live google` re-records and passes with credential `google` present, skips with an explicit reason otherwise.
- Prompt assembly with sections, the harness section (minimal: identity of the run, "Tools available: none.", the closing sentence), content hashes per `agents-and-prompts.md`; `POST /agents/reload`; load errors surfaced in `GET /agents`.
- `workbench dev` (Vite proxy, CSP relaxed only there); `run agent … --model`.
- Agents screen (list with version hash, policy, load errors; detail; run form with `--input` and model override); Runs: the summary layer per run and step (D-58: what happened, cost, what changed, what needs you) above the timeline of steps → model calls with compiled prompt, streamed response, usage, cost; Welcome gains the "add a provider key" step; errors follow the what/why/what-to-do template.
- Port the three Agent Hub agents into `examples/workspace/agents/{architect,weaver,cutter}/` with `instructions.md`; the bible is, for now, an extra section at the end of each agent's `instructions.md` (a project document injected via `documents` from RUN-03).

**Do not.** Add fallback logic, other adapters, tools, workflows, memory, offline mode, or a Models screen.

**Definition of done** (`npm run dod -- 01`).
1. `npm run contract` green on mock; `--live google` green when the key is set.
2. `workbench run agent architect --input "<premise>" --provider mock --json` returns text and `costUsd`; the model call row carries `prompt_version` and `agent_version`; `agent_versions` has the row.
3. Editing `instructions.md` changes `agent_version` and `prompt_version` on the next run; changing only the task input changes neither.
4. e2e: run Architect from the Agents screen, watch text stream, open the run, read its three-line summary, expand to the compiled prompt, usage, and cost.

**SEC.** 06 re-verified through the real adapter path; 20 as an early partial (the `x-goog-api-key` header is never stored on the model-call path); 07 (the adapter folder cannot reference `process.env` or global `fetch`, enforced by lint and a test).

**Human verification.** Put your Gemini key in `config/credentials.json`, run Architect on a premise from the UI, watch it stream, open the trace and read exactly what was sent.
