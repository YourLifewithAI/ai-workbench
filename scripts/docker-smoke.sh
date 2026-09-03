#!/usr/bin/env bash
# RUN-00 DoD 6: run the image with a temp workspace volume and check DoD items 2 and 3 from inside the container.
set -euo pipefail
IMAGE="${1:-ai-workbench:ci}"
NAME="wb-smoke-$$"
VOL="wb-smoke-vol-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; docker volume rm "$VOL" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== item 3: headless run with no runtime (fresh container, entrypoint creates the workspace)"
OUT=$(docker run --rm -v "$VOL:/workspace" "$IMAGE" run agent echo --input hi --provider mock --json)
echo "$OUT"
echo "$OUT" | grep -q '"state": "completed"' || { echo "run did not complete"; exit 1; }
RUN_ID=$(echo "$OUT" | sed -n 's/.*"runId": "\([A-Z0-9]*\)".*/\1/p')
TRACE=$(docker run --rm -v "$VOL:/workspace" "$IMAGE" trace "$RUN_ID" --json)
for t in run-started step-started model-started model-completed step-completed run-completed; do
  echo "$TRACE" | grep -q "\"type\":\"$t\"" || { echo "trace lacks $t"; exit 1; }
done
echo "trace ok"

echo "== item 2: start prints one URL line, binds 127.0.0.1 only, cleans up on SIGTERM"
docker run -d --name "$NAME" -v "$VOL:/workspace" "$IMAGE" start >/dev/null
for i in $(seq 1 60); do
  if docker logs "$NAME" 2>/dev/null | grep -q '#token='; then break; fi
  sleep 0.5
done
LINES=$(docker logs "$NAME" 2>/dev/null | grep -c . || true)
docker logs "$NAME" 2>/dev/null | sed 's/token=.*/token=…/'
[ "$LINES" = "1" ] || { echo "expected exactly one stdout line, got $LINES"; exit 1; }
docker exec "$NAME" node -e '
const net = require("node:net");
const probe = (host) => new Promise((r) => { const s = net.connect({ host, port: 8787 }); s.once("connect", () => { s.destroy(); r(false); }); s.once("error", () => r(true)); });
(async () => {
  const v6 = await probe("::1"); const v4 = await probe("127.0.0.1");
  console.log("[::1] refused:", v6, "| 127.0.0.1 accepts:", !v4);
  process.exit(v6 && !v4 ? 0 : 1);
})();'
docker exec "$NAME" test -f /workspace/data/runtime.json
docker exec "$NAME" test -f /workspace/data/runtime.token
docker exec "$NAME" node dist/cli.js run agent echo --input "via http inside the container" --json | grep -q '"state": "completed"'
docker stop -t 10 "$NAME" >/dev/null
CODE=$(docker inspect "$NAME" --format '{{.State.ExitCode}}')
[ "$CODE" = "0" ] || { echo "container exited with $CODE after SIGTERM"; docker logs "$NAME"; exit 1; }
docker run --rm -v "$VOL:/workspace" --entrypoint sh "$IMAGE" -c 'test ! -e /workspace/data/runtime.json && test ! -e /workspace/data/runtime.token && echo "runtime files removed"'

echo "== RUN-09: the image carries its sandbox, so the execute tier is not switched off in the shipped thing"
docker run --rm -v "$VOL:/workspace" --entrypoint sh "$IMAGE" -c 'deno --version | head -1'
docker run --rm -v "$VOL:/workspace" "$IMAGE" doctor --json | grep -q '"name": "deno"' || { echo "doctor does not report deno"; exit 1; }
docker run --rm -v "$VOL:/workspace" "$IMAGE" doctor --json | grep -q 'the sandbox is available' || { echo "the image has no sandbox"; exit 1; }

echo "docker smoke: ok"
