# STATUS

**Current run:** RUN-18: awaiting verification @ d866994 · RUN-14 awaiting verification @ 288da01 · RUN-13 awaiting verification @ 57d39fe · RUN-17 awaiting verification @ fed2ff2 · RUN-16 awaiting verification @ 63df105 · RUN-00 … RUN-12, RUN-15 and the maintenance branches are merged · awaiting the owner's verification scripts
**Last verified:** every run merged to `main` with CI green on **Linux, macOS and Windows**, plus Docker and a machine without a sandbox; the owner's scripts in each `runlog/` are still outstanding
**Gates:** `npm run check` green (unit 113 · security 154 · contract 51) · every `tests/dod/RUN-*.test.ts` suite green on all three platforms (DoD 07-2 is live-only) · `npm run e2e` 44 passed · Docker smoke and a no-sandbox job: CI

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:**
- No provider credential exists in the build environment, so the cloud adapters are verified against authored
  fixtures replayed through the real SDKs, not the live APIs. `npm run contract -- --live <adapter>` closes that,
  and `WB_LIVE=1 npm run dod -- 04` runs the story pipeline on a real model.
- The phone is verified at an iPhone viewport in Chromium, not on an iPhone. Safari only offers push to an
  installed app, so the Add-to-Home-Screen script in `runlog/RUN-12.md` is what proves it.
- The briefing has never reached the real web. Every fetch above went to a local socket that believes it is
  `allowed.test`. `WB_LIVE=1 npm run dod -- 07` with `WORKBENCH_CRED_BRAVE` and a model key is what proves it.
- Windows is verified on `windows-latest` in CI, not on the owner's machine. What CI cannot check there is the
  install on a machine with no Visual Studio (the README's `--ignore-scripts` path), `~` expansion in cmd.exe
  and PowerShell, the credentials ACL on a profile that is not an administrator's, and a runtime kept alive by
  the Task Scheduler recipe in `deploy.md`.
