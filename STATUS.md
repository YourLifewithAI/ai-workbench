# STATUS

**Current run:** RUN-03 — Projects, documents, files: the Library · awaiting verification @ `a5fe909`
**Last verified:** RUN-00, RUN-01 and RUN-02 merged with CI green; the owner's scripts are still outstanding
**Gates:** `npm run check` green @ `a5fe909` · `npm run dod -- 00 / 01 / 02 / 03` green · `npm run e2e` 14 passed · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:** no provider credential exists in the build environment, so the cloud adapters are
verified against authored fixtures replayed through the real SDKs, not against the live APIs.
`npm run contract -- --live <adapter>` is the command that closes that gap.
