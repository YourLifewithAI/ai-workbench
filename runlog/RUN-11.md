# RUN-11 handoff — Import/export, plugins, credentials UI, docs, packaging

**Branch:** `run/11-packaging` · **Head:** `c3ffa14` · **Status:** awaiting verification

## Built
- `src/runtime/transfer/bundle.ts` — one envelope for agents, workflows, memory and runs: what it is, what version it speaks, and what the redactor took out on the way. `bundle()` refuses to produce an envelope that changed the payload without leaving a marker, because a bundle that says it redacted nothing when it did would be worse than one that redacts nothing at all.
- **The trust strip (D-34).** An imported agent arrives with what it *asks for* intact — that is the author telling you what it needs — and with nothing granted. The import writes agent files and cannot reach `config/workbench.json`, so there is no code path by which a downloaded file becomes an authorization.
- `src/runtime/plugins/loader.ts` — plugins load from `<workspace>/plugins/` only, and only after a human has acknowledged that exact `name@version`. Before importing anything of the plugin's, the loader refuses a version range, a directory whose name disagrees with the manifest, an entry that resolves outside the plugin directory (symlinks included), a `package.json` version that disagrees, and any install-time script. Tools are namespaced `<plugin>.<tool>` and arrive granted to nobody.
- Settings, editable at last: a credentials editor that writes the 0600 file and answers with names rather than values; budgets, retention and execution merged key by key; the MCP server block; and the plugin list with the warning inline. Grants are deliberately not editable here — the matrix is the Tools screen.
- Routes: `GET /export/{agent,workflow,memory,runs}`, `POST /import/{agent,workflow,memory}`, `POST /plugins/trust`, `PUT /settings`, `PUT /settings/credentials`. CLI: `workbench export`, `workbench import`, `workbench plugins list|trust`, `workbench settings get|set-credential` (which reads a key from stdin so it stays out of shell history).
- Docs: a README with a ten-minute path and the five core tasks, `CONTRIBUTING.md` with the adapter on-ramp (pass the contract suite), and `deploy.md` gaining a Caddy recipe and a systemd unit for people without Tailscale or without Docker.

## Not built (deliberate)
- A marketplace, an OS keychain backend, Tauri packaging, cloud sync — the brief's *Do not*.
- Evaluator plugins register nothing yet. RUN-10's evaluators are a closed discriminated union, and widening it should be a decision rather than a load-time surprise; the loader accepts the manifest kind and says so.
- Editing grants from Settings. Two screens for one decision is how a person ends up not knowing which one won.

## Deviations from the brief
- **The plugin acknowledgement is per name *and version*.** The brief says the warning is shown once; once per version is what that has to mean, or a version bump is a way to skip it. Amended.
- **`PUT /settings` merges rather than replaces**, and writes only the keys it was given: a hand-edited `workbench.json` keeps its shape, and unset keys stay unset so defaults still apply (D-20). Amended.

## Verification transcript
```
$ npm run check
typecheck · lint · unit · security · contract · secret-scan — green
$ npm run dod -- 11
6 passed, then the e2e case tagged @run-11 passed
$ npx vitest run --project dod
every suite, 00 through 12 — green
$ npm run e2e
green, axe clean on every screen
```

## SEC tests added
`tests/security/sec-25-27-transfer.test.ts`, 7 cases:
- **SEC-25** an imported agent's permissions arrive as requests and the strip says so; a `schemaVersion` this workbench does not read is refused in both directions, with a message that says which way round it is; a workflow bundle is not an agent bundle whatever route it arrived at.
- **SEC-26** an export redacts and *lists what it redacted*; a clean bundle says so honestly rather than by omission.
- **SEC-27** nothing loads unacknowledged; a bumped version is not covered by the old acknowledgement; a range, a mismatched directory, a symlinked entry and an install script are each refused with their own reason; a plugin outside `plugins/` is not a plugin at all; and end to end, an acknowledged plugin's tool is in the matrix granted to nobody.

## Bugs found by the tests
- **A credential saved through the API was invisible until the next restart** — and, worse, unredacted: the runtime held a snapshot of the credentials file, so a key saved mid-session would have gone into the next trace in full. `Credentials` reloads now, and registering with the redactor is additive: a key removed from the file stays redacted for the rest of the process's life, because an old key in an old trace is still a key.
- **The settings test asserted the file rather than the effective config.** Writing only the keys a person set is the point (D-20); the assertion now reads the settings route, where the defaults have filled in.

## Spec amendments made
- `spec/tools-and-security.md` — per-version acknowledgement, the loader's refusals, and namespaced plugin tools
- `spec/api-and-cli.md` — `PUT /settings`, `PUT /settings/credentials`, `POST /plugins/trust`

## What is left
This is the last run in the sequence. `spec/vision.md` holds what was deliberately deferred: a native iOS wrapper, a container sandbox, embeddings, multi-user, and a marketplace. None of them are blocked by anything here.

## Still outstanding for the owner
- **No cloud adapter has spoken to its provider.** Everything is verified against recorded fixtures replayed through the real SDKs. `npm run contract -- --live google` and `WB_LIVE=1 npm run dod -- 04` close that with a key.
- **The phone has only been seen at an iPhone viewport in Chromium.** The Add-to-Home-Screen script in `runlog/RUN-12.md` is what proves it.
- **The ten-minute path has only been walked by its author.** The human verification for this run is the one that matters most: hand the repository to someone else and watch. Every stumble is a fix.
