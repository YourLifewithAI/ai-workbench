# RUN-18 handoff — Project spaces

**Branch:** `run/18-project-spaces` · **Head:** `d866994` · **Status:** awaiting verification

## Built
- `src/shared/project.ts` — the `ProjectSpace` schema (`schemaVersion`, `name?`, `description?`, `goals?`, `agents[]`, `tools[]?`, `memory[]`) and `EMPTY_SPACE`; strict, so a key that could only widen (there is none) is a validation error.
- `src/runtime/workspace/spaces.ts` — `loadSpaces` (a file that does not load is a `BrokenSpace`, never a throw), `diskState`, `versionOf` (content hash of the parsed form), `saveSpace` hash-pinned with `SpaceWriteError` (`validation` · `not_found` · `conflict` carrying `currentVersion`); `NO_FILE = 'none'` is the version a form pins before a file exists.
- `src/runtime/workspace/loader.ts`, `src/runtime/runtime.ts` — `spaces` and `brokenSpaces` on the workspace; reloaded with agents and workflows and after every save; `spaceOf(slug)` for the API; `saveSpace`.
- `src/runtime/security/permissions.ts` — `GrantSource.projectCeiling`; the decision refuses a tool outside the ceiling by name (`"calc" is not allowed in project site.`) after the grant checks, so an ungranted tool still reads as ungranted.
- `src/runtime/tools/executor.ts`, `src/runtime/engine/step.ts` — the ceiling threaded through `availableTo`, `decisionFor` and `ExecuteInput`; `ceilingFor(project)`; `goalsFor` (the `goals` prompt section from the project's document, `goals-missing` event when it is absent); `knowledgeFor` injects a document once when it is both knowledge and goals; `allowedScopes(project)`; `scopesFor(agent, project, allowed?)` filters, never adds.
- `src/runtime/engine/prompt.ts` — `AssembleOptions.goals`: an instruction section after the agent's own, inside the stable prefix, outside `promptVersion`.
- `src/runtime/tools/builtin/memory.ts`, `src/runtime/engine/run.ts` — `memory.remember` refuses a scope the project does not list by name; the memory tools' `scopesFor` is the narrowed one.
- `src/runtime/permissions/review.ts` — `ProjectFact[]` in the facts and the brief; the `nowhere` candidate (a grant no project the agent works in allows) with a *Take back* proposal; `FindingKind` gains `nowhere`.
- `src/runtime/api/app.ts` — `GET /projects/:slug/space` (the file, its version, whether it exists, the project's document paths, a load error if any) and `PUT /projects/:slug/space` `{ space, baseVersion }` (409 with `currentVersion` when the file moved); `spec/api-and-cli.md` row.
- `src/runtime/cli/commands/library.ts` — `workbench projects show` prints the space; `workbench projects space <slug> --goals --agents --tools --no-ceiling --memory` sets it through the same route.
- `src/ui/screens/Library.tsx` — the *Space* card on a project's page: goals picker, memory scopes, this project's agents, the tool ceiling behind a *Limit the tools in this project* switch; *Save space*; the conflict alert with *Load what is on disk*.
- `src/ui/screens/Agents.tsx` — `?project=` groups the list into *This project's agents* and *Others* and carries the project to the agent's form; `AgentCard` extracted.
- `src/ui/screens/Review.tsx` — the `nowhere` label, *allowed nowhere*.
- `examples/workspace/projects/anthology/project.json`, `…/companion/project.json` — the two shipped spaces: the anthology's agents and memory, with no ceiling and no goals (a ceiling would refuse whatever a person grants on Tools until they also came here, and the bible is knowledge, RUN-03); the companion's `about.md` as goals, the two memory tools as its ceiling, and no `workspace` memory.
- `tests/dod/RUN-18.test.ts`, `tests/security/sec-38-project-ceiling.test.ts`, `tests/e2e/library.spec.ts` (@run-18), `tests/e2e/agents.spec.ts` (@run-18).

## Not built (deliberate)
- Per-project budgets — the brief says no; the spend view reports by subject and per-agent caps exist (F6).
- A workflow's *Run it* listing agents — a workflow's agents are its steps; there is nothing to reorder there. The agent list and the agent run form are where a project's agents come first.
- A diff panel on a space conflict — a space is a few lists, so the conflict alert says the file moved and offers *Load what is on disk*; the workflow editor's diff was for a file a person cannot hold in their head.

## Deviations from the brief
- The brief said "do not read goals as data". They are instructions **while a person wrote their latest version**; a version a run filed (any agent with `artifact.write` in the project, after any fetch) is fenced as `goals.untrusted` with a `goals-fenced` event until a person writes the next one. Otherwise a run that had read the web could write the next run's instructions through the Library, which SEC-14 exists to prevent. D-69 amended in place.
- The shipped anthology space carries agents and memory only: no ceiling (a person's grant on Tools would be refused in the project until they came here too, which every DoD suite that grants a tool and runs in `anthology` showed at once) and no goals (the bible is knowledge, fenced, RUN-03 DoD 1).
- The brief named the new candidate kind `reach`; that kind already existed (RUN-14: net reach wider than the need). The kind is **`nowhere`** and its label *allowed nowhere*. Same evidence, same proposal.
- The brief's DoD 5 wanted `permissions.facts` to list the projects: it does, and so does the auditor's brief (`briefOf`), so the auditor can see the ceilings without a second tool call.

## Verification transcript
```
$ npm run check
typecheck · lint · unit 113 passed (20 files) · security 154 passed (27 files) · contract 51 passed (4 files)
route-drift: clean (85 routes, documented and implemented agree) · secret-scan: clean
$ npx vitest run --project dod
Test Files 19 passed · Tests 131 passed | 2 skipped (133)   (DoD 07-2 and 04-live are live-only)
$ npm run dod -- 18
7 passed: goals in anthology after the agent's sections and absent elsewhere; a document once when it is knowledge and goals;
goals a run wrote are fenced and a person's edit restores them; a missing goals document warns and the run completes;
calc refused in a project whose ceiling omits it and allowed where there is none, the refusal on Tools; a workspace-scope
write refused in the companion project and retrieval limited to its scopes; a stale save 409 with the current version and
a fresh one reloaded at once; the projects in the facts, the nowhere candidate raised and applied.
$ npx vitest run --project security tests/security/sec-38-project-ceiling.test.ts
3 passed (every agent × tool × 62 ceilings; the memory list; the schema)
$ npm run build && npm run e2e
44 passed (1.4m), including @run-18 on library.spec.ts and agents.spec.ts
```

## SEC tests added
- SEC-38 → `tests/security/sec-38-project-ceiling.test.ts` (every agent × tool × 62 ceilings including the empty and the full: allowed-with implies allowed-without with the same approval; a refusal names the project; an ungranted tool's decision is identical with or without; a memory list only removes scopes; the schema has no key that could lift an approval or widen `maxPermissions`).

## Spec amendments made
- `spec/artifacts-and-memory.md` §Projects — `project.json`, goals as an instruction section, memory narrowing, the load and save path.
- `spec/ui.md` — the Space card, the Agents grouping, the `nowhere` label.
- `spec/data-model.md` — no table; the file and its version; the `goals-missing` event.
- `spec/api-and-cli.md` — the two routes.
- `README.md` — one sentence under *What it does*.

## Known gaps
- `src/ui/screens/Library.tsx` — the goals picker lists documents only; a goals page that does not exist yet has to be created first (Library → the project → a document), then picked.
- The permissions review's `nowhere` candidate fires only when every project the agent belongs to has a ceiling; a project without one allows everything, which is the honest reading and also means a workspace with no ceilings never sees the kind.

## Notes for the next run
- A ceiling is a `ProjectCeiling` (`{ project, tools }`) computed by `StepRunner.ceilingFor`; the executor never reads the workspace itself. If a future run wants per-step ceilings, they compose through `effectivePermissions` the same way.
- `scopesFor` with an `allowed` list is the one place memory narrows; the memory tool's `scopesFor` dependency is bound to it in `run.ts`, so a new caller must pass `steps.allowedScopes(project)` or it will read every scope.
- The companion project lists `agent`, `project`, `user` — no `workspace` — on purpose: the owner's space does not read the workspace's shared notes. F6's companion agent still declares `about.md` in `documents`; it is injected once, as goals.

## Human verification script
1. Library → **companion** → *Space*: goals is `about.md`; memory has no `workspace`; the ceiling is the two memory tools. Untick `memory.search`, *Save space*, read *Saved*.
2. Agents → **Companion** (Welcome's last step opens it with the project chosen) → run it with the mock. Runs → the run → the compiled prompt: `## goals` after the companion's sections, with your `about.md` text. A `memory.search` call, if the model made one, is refused: *not allowed in project companion*.
3. Tick `memory.search` back and save. Edit `about.md` in the Library (a new version), run again: the new text is in the prompt.
4. Agents with `?project=anthology` (Library → anthology → the empty-state's *Run an agent here*, or type it): *This project's agents* lists the architect, the weaver and the cutter; the others follow.
5. `workbench projects show anthology` prints the space; `workbench projects space anthology --agents architect,weaver` then `show` again.
