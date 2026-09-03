#!/bin/sh
# Creates the workspace on first start, then runs the workbench CLI with the given arguments (default: start).
set -eu
WS="${WORKBENCH_WORKSPACE:-/workspace}"
if [ ! -f "$WS/workspace.json" ]; then
  node /app/dist/cli.js init "$WS" --name "${WORKBENCH_WORKSPACE_NAME:-workspace}" >&2
fi
if [ "$#" -eq 0 ]; then set -- start; fi
exec node /app/dist/cli.js "$@"
