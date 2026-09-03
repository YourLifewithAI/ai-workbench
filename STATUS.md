# STATUS

**Current run:** RUN-06 — Tool runtime, permissions, approvals, safe tools, delegate · awaiting verification @ `3a7a0a3`
**Last verified:** RUN-00 … RUN-05 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green · `npm run dod -- 00 … 06` green · `npm run e2e` 21 passed · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:** no provider credential exists in the build environment, so the cloud adapters are
verified against authored fixtures replayed through the real SDKs, not against the live APIs.
`npm run contract -- --live <adapter>` closes that gap, and `WB_LIVE=1 npm run dod -- 04` runs the story
pipeline on a real model once a credential exists.
