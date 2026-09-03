# Research notes

*Not capped. This is the evidence behind D-46 … D-59 and several defaults. arXiv ids marked † were not re-verified in this session (the network blocked arxiv.org); every other id and number below was confirmed from search-indexed abstracts on 2026-09-03.*

## How to read this

Each entry: id · title (year) · what it shows · what we did with it. "Adopted" means a decision or default in this spec cites it. "Rejected for now" means we understood it and chose not to build it yet, with the unlock trigger in `vision.md`.

## Context management and token cost

- **2508.21433** · *The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management* (2025). On SWE-bench Verified, replacing old tool observations with a placeholder halves cost relative to a raw agent while matching or slightly beating LLM summarization (Qwen3-Coder 480B: 53.8% raw → 54.8% masked). **Adopted → D-47**: the agent loop masks older tool results with a one-line placeholder; no LLM summarization by default.
- **2510.11967** · *Scaling Long-Horizon LLM Agent via Context-Folding* (2025). A 32K active context with folding reaches 62.0% on BrowseComp-Plus and 58.0% on SWE-bench Verified, beating baselines that used 327K. **Adopted (partly) → D-48**: steps and delegations exchange outputs and briefs, never transcripts; folding within a single step is a later refinement.
- **2601.06007** · *Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks* (2026). Across OpenAI, Anthropic, and Google, prompt caching cuts API cost 45–80% and time-to-first-token 13–31%; a single changed character in the system prompt invalidates the prefix; dynamic content belongs at the end, dynamic tool results should be excluded from cached blocks, and naive full-context caching can raise latency. **Adopted → D-46**: stable prefix first, the per-call harness block last, deterministic tool-spec serialization, adapter-placed cache breakpoints.
- **2507.07400** · *KVFlow: Efficient Prefix Caching for Accelerating LLM-Based Multi-Agent Workflows* (2025). In multi-agent workloads the reusable prefix is each agent's fixed system prompt + tool definitions; reactive eviction throws it away between invocations. **Adopted → D-46** (same prefix discipline applies to local models via the OpenAI-compatible adapter).
- **2601.14470** · *Tokenomics: Quantifying Where Tokens Are Used in Agentic Software Engineering* (2026). Over 30 ChatDev tasks, input tokens are 53.9% of spend, output 24.4%, reasoning 21.6%; the iterative review stage alone is 59.4%; refinement and verification cost more than generation. **Adopted → D-48, D-49**: review loops are capped (reject-with-feedback ≤ 2), reviewer steps default to cheaper models, and the spec warns against chains that re-inject whole artifacts.
- **2307.03172** · *Lost in the Middle: How Language Models Use Long Contexts* (2023; TACL 2024). Accuracy follows a U-shape in position and degrades by more than 30% when the relevant passage is mid-context, across six model families. **Adopted → D-53**: retrieved memory and knowledge sit adjacent to the task at the end of the prompt, with size budgets, never in the middle.
- **2502.09977** · *LaRA: Benchmarking Retrieval-Augmented Generation and Long-Context LLMs* (2025). No silver bullet: well-resourced long context wins on average, RAG is far cheaper; long context suits evenly distributed evidence, retrieval suits sparse evidence when retrieval is accurate. **Adopted → D-53**: FTS retrieval with small top-N by default; whole-document injection is an explicit per-step choice (`project.documents[...]`).

## Routing and model choice

- **2305.05176** · *FrugalGPT* (2023). Cascades of cheaper models match the best single model with up to 98% cost reduction, or beat it by 4% accuracy. **Adopted → D-50** as authoring guidance (cheap model first for extraction, classification, planning, judging); automatic cascades remain gated on experiment history (D-06).
- **2406.18665** · *RouteLLM: Learning to Route LLMs with Preference Data* (2024). Routers trained on preference data cut cost by over 85% on MT-Bench, 45% on MMLU, 35% on GSM8K versus GPT-4 alone, at 95% of its quality, routing 14% of queries to the strong model. **Adopted → D-50 and D-06's unlock**: our Compare ratings *are* preference data; when enough exist, a router can be trained from them.
- **2603.04445** · *Dynamic Model Routing and Cascading for Efficient LLM Inference: A Survey* (2026). Routing decides once; cascading escalates on inadequate output. **Noted**: the two are different mechanisms; the spec's per-step `model` override is routing by authoring, and fallback (D-04) is not a quality cascade.

## Tool use

- **2402.01030** · *Executable Code Actions Elicit Better LLM Agents* (ICML 2024). Code as the action space gives up to 20% absolute higher success with up to 30% fewer actions on M3ToolEval (82 multi-tool tasks). **Adopted → D-55**: once the sandbox exists, `code.execute` exposes the agent's granted tools as functions inside Deno, so several tool calls compose in one turn under the same broker.
- **2608.06370** · *The Bitter Lesson of Tool Calling* (2026). Code-execution actions match or beat structured tool calls in 13 of 14 models under parallel fan-out; gains concentrate in parallel and compositional scenarios. **Adopted → D-47 (parallel tool calls executed concurrently) and D-55.**

## Multi-agent design

- **2503.13657** · *Why Do Multi-Agent LLM Systems Fail?* (2025; NeurIPS). MAST: 14 failure modes in three categories — specification and system design 41.8%, inter-agent misalignment 36.9%, task verification 21.3% — from 1,600+ annotated traces across seven frameworks (initial 150 traces, κ = 0.88); gains over single-agent baselines are often minimal. **Adopted → D-49**: default to one agent with tools; add steps only for parallelism, a different model, or an independent verifier; the workflow validator's "smell" warnings encode the taxonomy's top causes.
- **2308.08155** · *AutoGen* (2023); **2308.00352†** · *MetaGPT* (2023); **2303.17760†** · *CAMEL* (2023). The conversation-loop and role-SOP lineages. **Rejected for now**: free-form agent conversation as the orchestration primitive; our DAG with explicit inputs is the "specification" MAST says most failures lack.

## Security

- **2406.13352** · *AgentDojo* (2024). 97 tasks, 629 injection cases; the best agent reaches 78% benign utility and GPT-4o falls from 69% to 50% utility under attack. **Adopted**: AgentDojo-style paired utility/attack cases are the shape of SEC-14 and SEC-19 tests.
- **2503.18813** · *Defeating Prompt Injections by Design (CaMeL)* (2025). A privileged planner and a quarantined reader, explicit control/data flow, and capabilities on values solve 77% of AgentDojo with provable security versus 84% undefended. **Adopted (lightly) → D-29**: run-level private taint plus `seenUrls` is the cheap cousin of CaMeL's value capabilities. **Rejected for now**: the full planner/reader split (changes the agent loop); value-level taint is the unlock in `vision.md`.
- **2506.01055** · *Simple Prompt Injection Attacks Can Leak Personal Data Observed by LLM Agents During Task Execution* (2025). Roughly 20% attack success on 16 AgentDojo tasks (about 15% over 48), 15–50% utility loss under attack, and no built-in defense fully prevents leakage; extraction and authorization tasks are worst. **Adopted → D-29's rationale**: the exfiltration rule exists because model-side defenses do not close this.
- **2601.04795** · *Defense Against Indirect Prompt Injection via Tool Result Parsing* (2026). Giving the model parsed, precise data from tool results while filtering injected instructions reaches the lowest attack success rate reported with competitive utility. **Adopted → D-51**: tools return structured data (Zod outputs), `http.fetch` returns extracted text with links separated, and every tool result is fenced as content.

## Memory

- **2502.12110** · *A-Mem: Agentic Memory for LLM Agents* (2025). Zettelkasten-style linked notes with selective top-k retrieval use 1,200–2,500 tokens per query against 16,900 for a MemGPT-style baseline on LoCoMo. **Adopted → D-53** (small top-N); **Rejected for now**: automatic note linking.
- **2504.19413** · *Mem0* (2025). Extracted memory needs about 1.8K tokens per conversation versus 26K for full context, with a 26% relative gain on an LLM-judge metric, 91% lower p95 latency, and over 90% token savings. **Noted**: supports scoped retrieval over full transcripts (D-17); automatic extraction stays a non-goal until the manual write paths prove insufficient.
- **2304.03442†** · *Generative Agents* (2023); **2310.08560†** · *MemGPT* (2023). Memory streams with reflection; OS-style paging. **Rejected for now**: reflection/consolidation loops; `supersedes` links are the manual equivalent.
- **2409.07429** · *Agent Workflow Memory* (2024). Inducing reusable workflows from successful trajectories improves WebArena success by 51.1% relative and Mind2Web step success by 24.6%. **Rejected for now**, recorded as backlog: "promote a successful run to a workflow" is the natural next feature after the review queue.

## Evaluation

- **2604.16706** · *Evaluating Tool-Using Language Agents: Judge Reliability, Propagation Cascades, and Runtime Mitigation* (2026). No configuration across five judges and five prompt strategies exceeds AUROC 0.65 on τ²-bench; 0.54 on AppWorld traces. **Adopted → D-36 stands**: model-judge scores are labeled estimates and never gate anything.
- **2406.12045** · *τ-bench* (2024). Evaluate by comparing end-state to a goal state; measure reliability with pass^k over repeated trials; current agents are inconsistent. **Adopted → D-52**: experiments run each case k times and report pass^k next to the mean.

## UI and human–agent interaction

- **Amershi et al., *Guidelines for Human-AI Interaction* (CHI 2019, doi 10.1145/3290605.3300233)** — not arXiv. Eighteen guidelines validated with 49 practitioners across 20 products: make clear what the system can do (G1) and how well (G2), show contextually relevant information (G4), support efficient dismissal and correction (G8, G9), make clear why it did what it did (G11), encourage granular feedback (G15), convey consequences (G16), provide global controls (G17), notify about changes (G18). **Adopted → `ui.md` §Friendly by design** maps each principle to a screen element.
- **2606.08919** · *Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human* (2026). Models the human approver as a fatiguing resource and shows the safety-optimal escalation rate sits below "escalate everything." **Adopted → D-57.**
- **2605.24309** · *Reframing LLM Agent Security as an Agent–Human Interaction Problem* (2026). A single coding task can raise dozens of approval prompts; by analogy with browser-warning fatigue (90%+ click-through) approvals become perfunctory and a malicious action buried in the stream is rubber-stamped. **Adopted → D-57** (batching, risk line, narrowest remember, no per-action modals).
- **2603.05941** · *XAI for Coding Agent Failures: Transforming Raw Execution Traces into Actionable Insights* (2026). With 20 participants, structured explanations (failure taxonomy, visual flow, plain-language cause, recommendation) found root causes 2.8× faster and proposed correct fixes with 73% higher accuracy than raw traces. **Adopted → D-58** (summary layer above the timeline).
- **2602.06593** · *AgentStepper* (2026) and **2402.08995** · *AgentLens* (2024). Overview-plus-detail, hierarchical behavior summaries, cause tracing, stepping through a trajectory. **Adopted → D-58's disclosure order**; stepping/breakpoints are backlog.
- **2607.26300** · *AgentGUI: An Interface for Observing and Steering Long-Running AI Agents* (2026). A local GUI for fleets of long-running agents: live trajectories, steering, coordination. **Noted**: validates the Dashboard's *Running* block and reattach-by-id; steering mid-run beyond cancel/review is backlog.
- **2606.20630** · *Design Principles for Human-Agent Interaction* (2026). Explanation depth should be calibrated to task complexity and user expertise; over-explanation costs efficiency, under-explanation erodes trust. **Adopted → D-58** (three-line summaries by default, everything else one click deeper).
- **2502.10844** · *Be Friendly, Not Friends: How LLM Sycophancy Shapes User Trust* (2025). Warm tone helps; agreement-seeking harms trust. **Adopted → D-59** copy rules (also applies to the agents' own outputs shown in Review).
- **2602.01405** · *Feedback by Design: Understanding and Overcoming User Feedback Barriers in Conversational Agents* (2026). Feedback is withheld when it costs effort or feels pointless. **Adopted → D-59** one-keystroke rating and the visible effect of ratings (Compare, preference data).
- **Nielsen, *10 Usability Heuristics* (1994) and NN/g on progressive disclosure and error messages** — not arXiv. Plain-language errors that state the problem and a recovery; secondary options deferred. **Adopted → `ui.md` empty states and error template.**
- **shadcn/ui WCAG 2.2 AA audit (2026, community)** — not arXiv. 34 of 48 components pass out of the box; the stock focus ring fails the 3:1 non-text contrast requirement. **Adopted → D-59** (raise the focus ring; audit the remaining components as screens ship).

## Top changes made to the spec from this literature

1. Prompt layout for cache reuse (D-46) — the single largest cost lever the papers agree on.
2. Observation masking and result truncation in the agent loop, parallel tool execution (D-47).
3. Briefs, not transcripts, between steps and to delegates (D-48).
4. Single-agent-first authoring guidance with validator smells from MAST (D-49).
5. Cheap-model-first guidance for extraction/judge/planner steps; Compare ratings as future router training data (D-50).
6. Structured tool results as the injection defense that pairs with the broker (D-51).
7. pass^k in experiments (D-52).
8. Retrieval placement and budgets (D-53).
9. Code-as-action through the sandbox tool bridge (D-55).
10. A guided first run, fatigue-aware approvals, a summary layer over traces, and a plain-language, accessible baseline (D-56 … D-59).
