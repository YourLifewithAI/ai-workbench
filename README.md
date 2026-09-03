# AI Workbench

A local-first, model-agnostic runtime for automated multi-agent, multi-model workflows. Models are a replaceable substrate; everything private (config, agents, runs, memory, keys) lives in one workspace directory you own; the runtime is one process on one port that never faces the public internet.

**Status:** RUN-00 (foundation and security floor) is built and awaiting human verification. See [`STATUS.md`](STATUS.md) and [`runlog/RUN-00.md`](runlog/RUN-00.md). Only the mock provider exists so far; real providers arrive in RUN-02.

## Quick start

Requires Node 22.

```sh
npm ci && npm run build
node dist/cli.js init ~/my-workspace
node dist/cli.js start --workspace ~/my-workspace
```

`start` prints one line, a URL ending in `#token=…`. Open it. The Welcome path runs the example agent on the built-in mock provider and shows you its trace. Headless, without a running runtime:

```sh
node dist/cli.js run agent echo --input "hello" --provider mock --json --workspace ~/my-workspace
node dist/cli.js trace <runId> --workspace ~/my-workspace
```

## How this repository is built

The specification in [`spec/`](spec/) is the source of truth. It is written to be executed by coding agents in sequential runs (`spec/runs/RUN-nn.md`), each with a definition of done that is a command, not a judgment: `npm run check`, `npm run dod -- nn`, `npm run e2e`. Every run ends with a handoff in `runlog/` and a human verification script. The protocol is in [`spec/runs/README.md`](spec/runs/README.md); `AGENTS.md` is the entry point for an agent.

## Security floor

Bound to `127.0.0.1`, bearer token per start (0600 file, printed once), Host and Origin checked before the token, strict CSP, credentials in a 0600 file or `WORKBENCH_CRED_*` and redacted from every trace, log, and response, child processes get an explicit allowlisted environment, and a secret scanner in the check gate. Tests for each of these live in `tests/security/` and stay forever (`spec/sec-catalog.md`).

## Deploying

[`deploy.md`](deploy.md): Docker on a VPS, reached over a Tailscale tailnet. The runtime is never exposed directly.

## License and contact

Apache-2.0 (see `LICENSE` and `NOTICE`). Security reports: `SECURITY.md`. Questions: `SUPPORT.md`.
