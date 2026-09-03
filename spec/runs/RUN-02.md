# RUN-02 — Adapters, fallback, offline mode, Privacy Inspector

**Goal.** The same agent runs unchanged on three providers and a local model; fallback and network mode are enforced by the runtime and visible in the UI. This is the model-independence claim, demonstrated.

**Reads.** `model-layer.md`, `tools-and-security.md` (egress), `data-model.md` (egress_log), `api-and-cli.md` (models, privacy routes), `ui.md` (Models, Runs → Privacy Inspector), `runlog/RUN-01.md`.

**Scope.**
- OpenAI-compatible adapter (configurable `baseUrl`; verified against Ollama and OpenRouter) plus Ollama management API for listing and availability; Anthropic adapter; the mock adapter's `baseUrl` round trip through its own loopback mock-upstream listener. Slices: one agent per adapter; the coordinator owns the egress checker, `egress_log`, the Models screen, and the Inspector.
- Normalized errors with `retryable` and `action` (D-05); selection, retry, and fallback semantics (D-04, D-06) with `model-aborted`, `fallback-selected`, `provider-meta-dropped` events; capability filtering from the catalog.
- The egress checker for model calls with modes `offline | local-only | allowlist | unrestricted` from `config/workbench.json`; `NetworkPolicyError` raised before any socket opens.
- Models screen; network-mode banner; Privacy Inspector tab on a run: destinations, purpose, data categories, bytes, redacted bodies, provider `dataPolicy`.

**Do not.** Add scoring or named routing policies, tools, workflows, memory.

**Definition of done** (`npm run dod -- 02`).
1. Contract suite green for mock, google, openai-compatible, anthropic (live per available key; fixtures otherwise).
2. A fixture that streams partial text on the primary and then fails with `action: 'fallback'` produces `model-started, model-aborted, fallback-selected, model-started, model-completed` and the run completes on the secondary; a fixture failing with `action: 'retry'` shows two further `model-started` on the same model before the fallback.
3. In `offline` mode a cloud model fails with `NetworkPolicyError` and no connection is attempted (asserted with a socket spy); a catalog entry with `locality: local` and a loopback `baseUrl` (the mock upstream) proceeds in `local-only`.
4. e2e: Models screen lists the models a stubbed Ollama management endpoint reports, greys cloud models in offline mode; the Privacy Inspector shows the destination, categories, and redacted body of a mock model call routed through `baseUrl`.

**SEC.** 08, 20.

**Human verification.** Run Weaver on Gemini, then on an Ollama model, then on Anthropic, from the same agent file; switch to offline and watch the cloud run refuse; read the Privacy Inspector for one run.
