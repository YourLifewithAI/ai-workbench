# RUN-10 — Evaluation and compare

**Goal.** The owner compares models on real steps and keeps the numbers honest. Taste becomes data.

**Reads.** `evaluation.md`, `data-model.md`, `api-and-cli.md` (datasets, experiments, compare routes), `ui.md` (Evaluate), `runlog/RUN-09.md`.

**Scope.**
- `datasets, cases, experiments, experiment_runs, scores`; dataset versions frozen once referenced; cases from past run inputs.
- Compare: one step × N model ids side by side with latency, tokens, stored cost, and per-run variance; the pick stored as ratings sharing a `compare_id`, in a shape usable as preference data (D-50); each pane links to its trace.
- Experiments as `experiment` runs under a budget, `k` trials per case (default 3) reporting pass^k beside the mean (D-52); evaluators `exact`, `schema`, `rule`, `model-judge` (labeled estimate), `human`; groundedness only for runs that used `knowledge.search`.
- Results table and chart; promptfoo-compatible dataset export/import where the mapping is free.
- Evaluate screen.

**Do not.** Add a hallucination metric. Feed any score into model selection.

**Definition of done** (`npm run dod -- 10`).
1. Compare Weaver across two mock "models": two traces linked from one view; the pick persists as a rating on both runs.
2. An experiment of 5 cases × 2 models × k=3 reports pass^3 and the mean, and stops at `maxCostUsd` under mock pricing with a clear `budget_exceeded`.
3. A `model-judge` score renders with the word "estimate"; `exact` and `schema` scores are exact.
4. A dataset exports to and re-imports from the promptfoo-compatible shape.
5. e2e covers Compare and the results table.

**SEC.** 28c, 06 (dataset export redaction).

**Human verification.** Compare the Synthesizer step of yesterday's briefing across three models, pick the best, run a five-case experiment and read the table.
