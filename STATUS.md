# STATUS

**Current run:** RUN-12 — Phone: installable web app and push · awaiting verification @ `d01a4b3`
**Last verified:** RUN-00 … RUN-06 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green · `npm run dod -- 00 … 06, 12` green · `npm run e2e` 25 passed · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:**
- No provider credential exists in the build environment, so the cloud adapters are verified against authored
  fixtures replayed through the real SDKs, not the live APIs. `npm run contract -- --live <adapter>` closes that,
  and `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on a real model.
- The phone is verified at an iPhone viewport in Chromium, not on an iPhone. Safari only offers push to an
  installed app, so the Add-to-Home-Screen script in `runlog/RUN-12.md` is what proves it.
