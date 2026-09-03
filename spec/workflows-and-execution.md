# Workflows and execution

*Prose cap: 1000 words. Decisions cited: D-11 … D-15, D-20.*

## `.workflow.json` (D-11)

```ts
const Step = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), dependsOn: z.array(z.string()).default([]),
  when: Expr.optional(),                          // skip the step when falsy
  review: z.enum(['none', 'blocking']).default('none'),
  budget: Budgets.partial().optional(), retries: z.number().int().max(2).default(0),
}).and(z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agent: z.string(), model: Template.optional(),
             input: Template, outputSchema: JsonSchema.optional(),
             output: z.object({ document: Template.optional() }).optional() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), input: Template }),
  z.object({ kind: z.literal('map'), over: Expr, concurrency: z.number().int().default(3),
             step: z.lazy(() => Step) }),   // one level of nesting; the inner step has its own id and no dependsOn
]));

const Workflow = z.object({
  schemaVersion: z.literal(1), id: z.string(), name: z.string(), description: z.string(),
  inputs: JsonSchema,                              // the run form is generated from this
  defaultProject: z.string().optional(),           // a run may override it
  steps: z.array(Step).min(1),
  outputs: z.record(Template),                    // e.g. { "briefing": "{{steps.synthesize.output}}" }
  budgets: Budgets.partial().optional(),
  permissions: Permissions.optional(),            // ceiling for every step
  schedule: z.object({ cron: z.string(), inputs: z.record(z.unknown()),
                       catchUp: z.enum(['none', 'once']).default('none') }).optional(),
});
```

`Template`, `Expr`, `JsonSchema`, `Budgets`, and `Permissions` are Zod types in `src/shared/` (permissions and budgets are shown in `tools-and-security.md` and below).

**Template.** A string containing `{{ … }}` placeholders, or a JSON object/array whose string leaves are such strings. A placeholder holds an `Expr`. If the whole string is exactly one placeholder, the value is passed through with its type (object, array, number); otherwise values are interpolated as text (objects and arrays as JSON). `\{{` is a literal. A reference that cannot resolve at run time fails the step with `TemplateError`.

**Expr.** Bare, no braces: paths (`inputs.topic`, `steps.plan.output.questions`, `steps.drafts.output[0]`, `project.documents["beats.md"]`, `item`), literals (`"text"`, `42`, `true`, `null`, `["a", "b"]`), comparisons (`== != < <= > >=`), `and or not`, `length(x)`. JavaScript truthiness. No calls other than `length`, no assignment, no arbitrary code — this is a small parser, never `eval`.

> Amendment (RUN-04, 2026-09-03): a step's `output.document` may be `null`, meaning "file nothing" — the step's output is intermediate whatever the agent's own `output.document` says. Without it a `map`'s parallel items all resolve to the same agent-default path and overwrite each other: three versions of one document where the author asked for three drafts.

> Amendment (RUN-04, 2026-09-03): template roots also include `runId` and `agentId`, the two an `output.document` path usually wants. They are the same names an agent's own `output.document` uses, so a path written in a workflow reads the same as one written in an agent.

**Names.** `inputs.*` is the run's validated input. `steps.<id>.output` is a step's output: the final text, or the validated JSON when `outputSchema` is set. A `map` step's output is an array in item order; each item runs as a step with id `<mapId>[<n>]` and its own `run_steps` row and events. `item` is the current element inside a map. `project.documents["<path>"]` is the latest version's text of a document in the run's project. A template reference to `steps.x` implies `dependsOn: ["x"]`; the validator adds the edge and rejects cycles.

**Semantics.** Independent steps run in parallel up to `execution.maxParallelSteps` (default 4). A step whose `when` is falsy is skipped with a `step-skipped` event; its output is `null` and dependents still run. The first failed step aborts running siblings and fails the run. `retries` re-runs a step from its beginning after a model error or an `outputSchema` failure (validated with a JSON Schema draft 2020-12 validator, after the model layer's one repair turn). A step's `model` template replaces the agent's primary and keeps the agent's `fallbacks[]`, so `map` over a list of model ids with `model: "{{item}}"` is an ensemble; `examples/workspace/workflows/ensemble-draft.workflow.json` maps three ids into `weaver` and feeds the array to the `judge` agent, whose `output` is `{ kind: 'json', schema: { winner: number, rationale: string } }`.

A run names its **project** at start (`--project`, the run form, or `defaultProject`). `output.document` is a document path in that project; a re-run creates a new version of the same path.

Workflow versions are content hashes (D-10). A run records the workflow version, every agent version, every prompt version, and every model id it used.

## The agent step loop

An agent step is a loop: model call → if the response contains tool calls, execute them through the broker (concurrently when there are several) and append the results → model call → … until the model finishes without tool calls, or a budget ends it. A call to a tool that does not exist or is not granted returns `{ ok: false, error: { code: 'UnknownTool' | 'PermissionDenied' } }` and the loop continues; the model is never crashed by its own mistake. The loop exists from RUN-04 even while the tool list is empty.

Context discipline (D-47): a tool result longer than `context.maxToolResultChars` is truncated in the transcript with a pointer to the full result in the run's scratch directory; once the loop has passed `context.keepRecentToolResults` tool rounds, older results are replaced by `[result of <tool> call <id> masked — artifact.read('scratch/<id>') to recover]`. The trace always keeps the full result. History is never summarized by a model unless a step opts in.

## Dynamic orchestration (D-12)

Planners call `agent.delegate({ agent, input, model?, budget? })`: a child run nested in the parent's trace, permissions = child's grant ∩ parent's effective, a budget carved from the parent's remainder, depth ≤ 3. A child cannot do anything the parent could not. `input` is a brief the planner writes; the parent's transcript is never shared (D-48).

**Authoring guidance (D-49, D-50).** Start with one agent and the tools it needs. Add a step only when the work parallelizes (`map`), a different model is right for it (cheap models for extraction, classification, planning, and judging), or an independent verifier is worth its tokens. The validator warns — never blocks — on the smells that predict failure: a step with no declared inputs, an artifact passed through more than two agents in sequence, a reviewer step with no reject path.

## Lifecycle (D-14)

Run kinds: `agent`, `workflow`, `experiment`. States:

```
queued → running → completed | failed | cancelled
              ↘ waiting_review → running        (blocking gate)
              ↘ waiting_approval → running      (sensitive action; tools-and-security.md)
interrupted (set on startup for anything that was running) → running via resume
```

A run is `queued` while `execution.maxConcurrentRuns` are running.

**Budgets** (`config/workbench.json`, narrowable per run, D-20):

```jsonc
"budgets": { "maxModelCalls": 60, "maxToolCalls": 120, "maxCostUsd": 2.0, "maxWallClockMs": 1800000,
             "toolCallTimeoutMs": 60000, "dailySpendCapUsd": 20.0 },
"execution": { "maxParallelSteps": 4, "maxConcurrentRuns": 2 },
"retention": { "scratchDays": 7 }
```

> Amendment (RUN-04, 2026-09-03): "the last permitted model call is the wrap-up turn" is implemented literally for `maxModelCalls` — one call is held back, so a budget of six means five productive calls and a sixth that summarises, and the count never exceeds the budget. Cost cannot be reserved the same way, since a call's price is not known until it returns; a wrap-up after a cost stop may carry the total slightly past `maxCostUsd`. The wrap-up does not emit a second `budget-warning` when 80% already announced that budget: one warning per budget means one.

At 80% of `maxModelCalls`, `maxToolCalls`, or `maxCostUsd` a `budget-warning` event is emitted once per budget and the next harness section says so. The last permitted model call is the wrap-up turn: tools removed, an instruction to summarize what exists and what remains; its output is committed as the step's output flagged `partial`, then the run is `failed { reason: 'budget_exceeded' }`. `maxWallClockMs` and the daily cap are hard stops with no wrap-up. The daily cap sums `model_calls.cost_usd` over the local calendar day; a run that would start past it is refused with `daily_cap_reached`, and a running one fails before its next model call.

**Cancel** is an API call and a button on every running run. It aborts every in-flight model call through `AbortSignal`, refuses further tool calls, records `run-cancelled`, and commits nothing from interrupted steps. Cancelling a queued run cancels it; cancelling a finished run is a 409.

**Resume.** Events are the source of truth. On startup every `running` run becomes `interrupted` (from RUN-04; the resume command arrives in RUN-05). Resume restarts from the last completed step; an in-progress step re-runs from its beginning; completed steps and their artifact versions are not duplicated.

## Scheduler (D-15)

Schedules live in the `schedules` table and are edited in the Workflows screen. A workflow file's `schedule` block seeds a row the first time the file is loaded and is otherwise ignored. The scheduler is in-process (`croner`, local time zone), honors `execution.maxConcurrentRuns`, and creates ordinary runs with the schedule's inputs. `catchUp: once` fires one run for a window missed while the runtime was down; `none` skips it. Scheduled runs are ordinary runs and are observable like any other (`api-and-cli.md`).

## Review (quality) and approval (security) are different queues (D-13)

**Review** is non-blocking by default: every completed step output appears in the Review screen as unreviewed. The human can rate 1–5, edit (a new artifact version with `createdBy: 'human'`), re-run downstream steps from an edited version, or reject with feedback, which re-runs the step with the feedback appended (at most twice). A step with `review: 'blocking'` parks the run in `waiting_review` with no timeout by default.

**Approval** is the security queue: a tool call that policy marks sensitive parks the run in `waiting_approval`, and the decision returns to the agent as a tool result. Mechanics (timeout, "remember", batches) are in `tools-and-security.md` §Approvals.
