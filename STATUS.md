# STATUS

**Current run:** RUN-04 — Workflows v1 and the execution lifecycle · awaiting verification @ `d0a941f`
**Last verified:** RUN-00 … RUN-03 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green @ `d0a941f` · `npm run dod -- 00 / 01 / 02 / 03 / 04` green · `npm run e2e` 17 passed · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:** no provider credential exists in the build environment, so the cloud adapters are
verified against authored fixtures replayed through the real SDKs, not against the live APIs.
`npm run contract -- --live <adapter>` is the command that closes that gap, and `WB_LIVE=1 npm run dod -- 04`
runs the story pipeline on a real model once a credential exists.
