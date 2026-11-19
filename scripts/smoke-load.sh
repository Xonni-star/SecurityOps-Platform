#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
REQUESTS="${REQUESTS:-100}"
CONCURRENCY="${CONCURRENCY:-10}"
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
export BASE_URL
seq "$REQUESTS" | xargs -P "$CONCURRENCY" -I{} curl --silent --show-error --fail --output /dev/null "$BASE_URL/health"
echo "completed ${REQUESTS} health requests with concurrency ${CONCURRENCY}"
