# STATUS

**Current run:** RUN-09 — Sandbox, filesystem, code execution, MCP, and the website workflow · awaiting verification
**Last verified:** RUN-00 … RUN-08 and RUN-12 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green · `npm run dod -- 00 … 09, 12` green (DoD 07-2 is live-only) · `npm run e2e` 28 passed · Docker smoke and a no-sandbox job: CI

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:**
- No provider credential exists in the build environment, so the cloud adapters are verified against authored
  fixtures replayed through the real SDKs, not the live APIs. `npm run contract -- --live <adapter>` closes that,
  and `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on a real model.
- The phone is verified at an iPhone viewport in Chromium, not on an iPhone. Safari only offers push to an
  installed app, so the Add-to-Home-Screen script in `runlog/RUN-12.md` is what proves it.
- The briefing has never reached the real web. Every fetch above went to a local socket that believes it is
  `allowed.test`. `WB_LIVE=1 npm run dod -- 07` with `WORKBENCH_CRED_BRAVE` and a model key is what proves it.
