#!/usr/bin/env bash
# Isolated local MOCK preview. No real credentials or external execution.
set -euo pipefail
# The cloud desktop may not inherit the executor runtime PATH.
if ! command -v node >/dev/null 2>&1 && [ -x /opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node ]; then
  export PATH="/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
fi
cd "$(dirname "$0")"
export EXECUTION_MODE=mock DEMO_AUTH=true NODE_ENV=development STORAGE_MODE=memory
export WEBHOOK_SECRET=local-mock-only-replace-with-random-32-plus-characters
export HOST=127.0.0.1 PORT=3101 FRONTEND_ORIGIN=http://127.0.0.1:4100
export API_INTERNAL_URL=http://127.0.0.1:3101 NEXT_TELEMETRY_DISABLED=1
node --import tsx apps/api/src/main.ts & API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT
node node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 -p 4100
