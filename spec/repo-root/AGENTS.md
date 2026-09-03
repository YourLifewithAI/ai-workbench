# AGENTS.md

You are building AI Workbench: a local-first runtime for automated, multi-agent, multi-model workflows. The human verifies and sets taste; you write the code. Start by reading `STATUS.md`, then `spec/runs/README.md`, then the brief it points to. Read only the spec documents your brief lists, plus `spec/sec-catalog.md` for the SEC ids it names and `spec/runs/TEMPLATE-handoff.md` when you finish.

**Gates.** `npm run check` (typecheck, lint with boundary rules, unit, security, secret scan) must be green before every commit. `npm run dod -- <nn>` is your definition of done. `npm run e2e` runs Playwright on the mock provider. Nothing needs an API key; live tests are opt-in.

**Rules.** Cite decisions as `D-nn` from `spec/decisions.md`; never contradict one silently — amend the spec in the same PR. Never widen a permission or budget default to pass a test. Never skip or quarantine a test. Never use `node:vm`, never execute model output in-process, never read `process.env` outside bootstrap and the credentials loader. Nothing the model saw may be hidden from the trace.

**Layout.** `src/shared` (Zod schemas, types), `src/runtime` (server + CLI), `src/ui` (SPA), `defaults/`, `tests/`, `examples/workspace/`, `spec/`, `runlog/`. Boundaries are lint-enforced; if an import is refused, the design is telling you something.

**Done.** Write `runlog/RUN-nn.md` from `spec/runs/TEMPLATE-handoff.md`, including the verification transcript and a human verification script, and update `STATUS.md`.
