# STATUS

**Current run:** none — RUN-00 … RUN-12 are all merged · awaiting the owner's verification scripts
**Last verified:** every run merged to `main` with CI green on Linux, macOS, Docker and a machine without a sandbox; the owner's scripts in each `runlog/` are still outstanding
**Gates:** `npm run check` green · `npm run dod -- 00 … 11, 12` green (DoD 07-2 is live-only) · `npm run e2e` 30 passed · Docker smoke and a no-sandbox job: CI

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:**
- No provider credential exists in the build environment, so the cloud adapters are verified against authored
  fixtures replayed through the real SDKs, not the live APIs. `npm run contract -- --live <adapter>` closes that,
  and `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on a real model.
- The phone is verified at an iPhone viewport in Chromium, not on an iPhone. Safari only offers push to an
  installed app, so the Add-to-Home-Screen script in `runlog/RUN-12.md` is what proves it.
- The briefing has never reached the real web. Every fetch above went to a local socket that believes it is
  `allowed.test`. `WB_LIVE=1 npm run dod -- 07` with `WORKBENCH_CRED_BRAVE` and a model key is what proves it.
