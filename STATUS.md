# STATUS

**Current run:** RUN-01 — Gemini, workspace agents, trace viewer · awaiting verification @ `345b371`
**Last verified:** RUN-00 (gates green in CI at merge; the owner's script is still outstanding)
**Gates:** `npm run check` green @ `345b371` · `npm run dod -- 00` green · `npm run dod -- 01` green · `npm run e2e` green · Docker smoke: CI job

Run agents update this file at the end of a run; the human updates it on acceptance.

**Outstanding for the owner:** a Gemini credential is the one thing this environment cannot supply. Until
`npm run contract -- --live google` has run once, the Google adapter is verified only against recorded fixtures.
