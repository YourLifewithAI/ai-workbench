# RUN-12 — Phone: installable web app and push

**Goal.** The owner approves, rates, and reads from an iPhone. The web app installs to the Home Screen and push notifications bring "needs you" moments to the phone with a deep link. Recommended after RUN-06 and before RUN-07.

**Reads.** `ui.md`, `api-and-cli.md` (push routes), `data-model.md` (`push_subscriptions`), `tools-and-security.md` (security floor), `runlog/RUN-06.md`.

**Scope.**
- Web app manifest (name, icons, `display: standalone`, theme colors for both themes) and a service worker that caches the application shell only — never API responses or workspace data (D-61).
- Phone layouts for Dashboard (*Needs you* first), Review (approval cards, rating with large targets), Runs summaries, and Library reading; the token handshake works from the installed app (the fragment survives Add to Home Screen; a "runtime token required" screen otherwise).
- Web Push: VAPID key pair generated at `workbench init` into `data/vapid.json` (0600); `GET /push/vapid-public-key`, `POST /push/subscribe`, `DELETE /push/subscriptions/:id`; `push_subscriptions` table; dispatch on `approval-requested`, a step entering `waiting_review` with `review: 'blocking'`, `run-failed`, and completion of a scheduled run; payload `{ kind, id, runId }` only; each notification deep-links to the item; Settings toggles per event per device.
- Tailnet exposure verified end to end with `--expose <tailnet-hostname>` and `tailscale serve` per `deploy.md`.

**Do not.** Cache any workspace data offline. Add a native app. Put content in push payloads.

**Definition of done** (`npm run dod -- 12`).
1. Playwright at an iPhone viewport: install prompt data is present (manifest validates), approve a pending item and rate an output using touch targets ≥ 44 px, read a briefing in the Library.
2. A test push subscriber (a Playwright service-worker harness with a stub push endpoint) receives the four notification kinds with the correct deep links; unsubscribing stops them.
3. `workbench init` writes `data/vapid.json` with mode 0600; `GET /push/vapid-public-key` returns it; `POST /push/subscribe` without the token is 401.
4. Lighthouse PWA audit passes installability on the built SPA.

**SEC.** 32 (payload contains ids and kinds only; a planted document title never appears in a push body), 01 re-verified for the push routes.

**Human verification.** On your iPhone on the tailnet, open the tokened URL, Add to Home Screen, open the installed app, approve a pending item; then start a run that will need approval, lock the phone, and get the notification; tap it and land on the card.
