# RUN-15 — The catalog learns what exists

**Goal.** A provider retiring a model, shipping a new one, or changing a price arrives as a notice on the Models screen — not as a failed run four months later.

**Reads.** `model-layer.md`, `architecture.md` (egress), `ui.md` (Models), `api-and-cli.md` (`/models/refresh`), D-06, D-08, D-64, D-65, `runlog/RUN-02.md`.

**Why now.** The first live run of this workbench failed at its first model call: every example agent pinned `gemini-2.5-pro`, retired to new keys some months after the catalog was written, with `2.5-flash` — also retired — as its fallback. Nothing in the system could have known. `POST /models/refresh` polls *local* endpoints only; no cloud provider is ever asked what it offers. The catalog is a hand-maintained snapshot, and snapshots rot.

**Scope.**
- **`listModels()` on the adapter contract, optional.** `ModelAdapter` gains `listModels?(ctx: AdapterContext): Promise<DiscoveredModel[]>`. Optional is the point: an `openai-compatible` endpoint may have no such route and the mock has nothing to list. An adapter that cannot list is not broken — its models stay hand-declared, exactly as today. Implement it for `google` and `anthropic`; the contract suite gains a `listModels` case for adapters that declare it.
- **Refresh diffs and proposes.** For each adapter with `listModels` and a credential, ask, then compare against `config/models.json` and emit findings:
  - **new** — offered, not in the catalog.
  - **retired** — in the catalog, no longer offered. Carries **the agents and workflow steps that pin it**, which is the field that turns this from trivia into a warning.
  - **repriced** — the provider states a price that differs from the row in effect. Cost and every budget cap depend on this number, so a stale one makes the caps lie.
  - **drift** — context window, tool calling, structured output, modality.
- **Nothing applies itself.** A finding is accepted by a person and the acceptance is an ordinary catalog write, indistinguishable from editing the file. A discovered model is written `enabled: false` (D-64). Dismissing a finding records the dismissal so the next refresh does not raise it again until the underlying facts change — the same shape as the permissions review (D-63).
- **Price unknown is unusable.** A cloud entry with empty `pricing` is listed with that reason and cannot be selected by a run (D-65). `doctor` reports it. The remedy is typing the price in, not guessing one.
- **The list is untrusted input.** It arrives over the network through the egress checker with `purpose: 'model'`, is refused in offline mode like any other call, and every string in it — id, display name, description — is data: it reaches no prompt, and it renders as text on the Models screen.
- **Models screen**: a *Check for changes* action, the findings with accept and dismiss, and a badge on any model that an agent pins but the provider no longer offers.
- CLI: `workbench models refresh` prints the findings; `workbench models accept <finding>` applies one.

**Do not.**
- Do not adopt anything automatically, and never rewrite an agent's `modelPolicy` (D-64, D-06). A retired primary is a finding against that agent, not a substitution.
- Do not invent a price, or carry one over from a similar model id. Absent beats confidently wrong (D-65).
- Do not enable a discovered model.
- Do not let the provider's text reach a prompt, a filename, or a shell.
- Do not make refresh automatic on a timer in this run. Discovery that runs unattended is one step from adoption that runs unattended, and the owner has not asked for it.

**Definition of done** (`npm run dod -- 15`).
1. A stub adapter listing one added, one dropped and one repriced model produces exactly three findings, and the retired one names the example agents that pin it.
2. Accepting the "new" finding writes the entry `enabled: false`; the next refresh raises nothing; a run cannot select it until it is enabled *and* priced.
3. A cloud entry with empty pricing is reported unusable, and a run naming it fails with that reason rather than costing $0.
4. Refresh in offline mode refuses with `NetworkPolicy` and opens no socket.
5. A listing whose display name contains `Ignore previous instructions…` reaches no compiled prompt, and the Models screen shows it as text.
6. Dismissing a finding suppresses it until the provider's answer changes.
7. e2e: Models shows the diff; one finding is accepted, one dismissed.

**SEC.** 08 (only a person writes a catalog the runtime will execute against), 06 (findings redacted like any body), plus a new case for the untrusted listing (5 above).

**Human verification.** Press *Check for changes* against a real Google key on a workspace whose agents still pin something retired, and confirm the finding names the agents before you accept anything.
