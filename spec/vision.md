# Vision

*Prose cap: 520 words.*

AI Workbench is a local-first runtime for automated, multi-agent, multi-model workflows that produce durable work. The model is replaceable infrastructure; the harness, tools, memory, workflows, and agent definitions are the user's and outlive any vendor. The private layer — agents, prompts, memories, documents, credentials, history — lives in a workspace directory the harness loads, never inside the harness.

## Who it is for

**Primary:** an owner-operator running private, scheduled, multi-model workflows — research briefings and situational awareness, writing pipelines, website building, marketing operations, and testing those workflows against each other. They verify and set taste; agents do the work.

**Secondary:** developers who add adapters, tools, and evaluators, proving compatibility by passing the contract suite.

## What it is not (and what unlocks each)

- A chat UI with a model picker — Open WebUI, LibreChat, and Jan exist.
- A developer framework — Mastra and LangGraph exist; this is a runtime with enforced permissions and a home for outputs.
- A single agent — Goose exists; this orchestrates many, each on the model that suits its step.
- A proxy or routing service — LiteLLM and OpenRouter exist; routing here is explicit policy, not a scoring engine.
- An eval product — promptfoo exists; compare-and-rate ships, and datasets stay promptfoo-compatible.

The design choices that come from published evidence rather than taste are collected in `research.md`.

Non-goals for Runs 00–11, with unlock triggers (Windows-native guarantees was one of these; the trigger fired and it is now supported, see D-39): distributed execution (a second machine that needs to run steps); native mobile wrapper (the installable web app of D-61 leaves something wanting); accounts and multi-user (a second person shares a workspace); marketplace (external contributors ship plugins); cloud sync (exports prove insufficient); scored routing (experiment history exists to feed it); embeddings and vector index (FTS over curated content demonstrably fails); enforced plugin isolation (a plugin from an untrusted source is wanted); container or WASM sandboxes (the Deno sandbox is shown insufficient); webhook triggers and browser-driven QA (a workflow needs them); desktop packaging (Docker is shown insufficient); value-level taint tracking in the CaMeL style (an injection gets past the run-level rule); automatic memory extraction (the manual write paths prove insufficient); inducing workflows from successful runs (the review queue shows the same run being repeated by hand). See `research.md`.

## The design tests

Ask at every decision:

1. *Could this component still work if today's best model disappeared tomorrow?* If not, the abstraction is in the wrong place.
2. *Could the owner run this entirely locally without trusting the project maintainers?* Subject only to the models and tools they explicitly call.

And one more, because agents build and inhabit this system:

3. *Would an agent want to work here?* One command verifies everything; nothing needs a key; formats have one source of truth; denials explain themselves; nothing the model saw is hidden. If a change makes the environment worse for the agent that has to live in it, it is the wrong change.

## License

Apache-2.0, chosen by the owner. No provider SDK source is vendored.
