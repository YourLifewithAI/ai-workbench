# Evaluation

*Prose cap: 350 words. Decisions cited: D-36, D-06.*

Evaluation exists so the owner can choose models and prompts on evidence, and so taste becomes data. It never feeds routing automatically (D-06) and never pretends a judge model is ground truth.

## Compare first

The Compare screen runs one agent step (or one case) across N model ids from the catalog, side by side: output, latency, tokens, stored cost. The owner picks the better one; the pick is stored as a rating linked to both runs. Each pane links to its full trace. This is the eval most owners actually use, and it costs nothing to build once runs exist.

## Entities

- **dataset** — named, versioned; a version is frozen once an experiment references it.
- **case** — `input` (matching the target's `inputs` schema), optional `reference`, metadata. Cases can be created from past run inputs in one click.
- **experiment** — a dataset version × a target (agent or workflow version) × a list of model ids × `k` trials per case (default 3), under a budget; results report pass^k beside the mean (D-52).
- **experiment run** — one case on one model, linked to an ordinary run (so it has a trace, a cost, and a privacy record).
- **score** — `evaluator`, `metric`, `value`, optional `rationale`, attached to a run.

## Evaluators

`exact` (string or JSON equality with `reference`), `schema` (output validates), `rule` (regex, length, contains), `grounded` (metric `groundedness`: fraction of claims a judge model finds supported by the run's retrieved chunks; available only for runs that used `knowledge.search`; labeled estimate), `model-judge` (a rubric prompt to a chosen model; every score is labeled *estimate* in the UI and never used as a gate — judge agreement with ground truth on tool-using traces tops out around AUROC 0.65, `research.md`), `human` (ratings).  There is no "hallucination" metric: it needs ground truth the system does not have.

## Results

A table (case × model × metric) with totals for cost and latency and a simple chart; export and import in a promptfoo-compatible JSON shape where the mapping is free, so datasets are portable.

> Amendment (RUN-10, 2026-09-03): a case carries an explicit `ordinal`. Two cases added in the same millisecond
> have ULIDs that do not sort against each other, and "case 1" in a results table has to mean the first one the
> person wrote.

> Amendment (RUN-10, 2026-09-03): a Compare pick writes the **model id** on every rating alongside the shared
> `compare_id`. A preference pair without the names of both sides is not usable as preference data (D-50).

> Amendment (RUN-10, 2026-09-03): the results table is the chart for now. A case × model grid with pass^k beside
> every mean is already the shape the eye reads; a chart on top of ten numbers would be decoration. It arrives
> when a dataset is big enough that the table stops being readable.
