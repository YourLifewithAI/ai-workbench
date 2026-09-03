# STATUS

**Current run:** RUN-02 — Adapters, fallback, offline mode, Privacy Inspector · awaiting verification @ `d4f729d`
**Last verified:** RUN-00 and RUN-01 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green @ `d4f729d` · `npm run dod -- 00 / 01 / 02` green · `npm run e2e` 10 passed · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:** no provider credential exists in the build environment, so the Google, Anthropic
and OpenAI-compatible adapters are verified against authored fixtures replayed through the real SDKs, not against
the live APIs. `npm run contract -- --live <adapter>` is the command that closes that gap.
