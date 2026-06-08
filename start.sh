#!/usr/bin/env bash
#
# start.sh — serve the Norway newspaper map locally.
#
# Runs serve.mjs, which serves the static files AND proxies the articles
# endpoint on the same origin (so there are no CORS errors).
#
# Usage:
#   ./start.sh                 # serve on port 8080 and open the browser
#   ./start.sh 3000            # serve on a custom port
#   ./start.sh --build         # (re)generate publications.json first, then serve
#   ./start.sh --build 3000    # rebuild, then serve on a custom port
#
set -euo pipefail

# Run from the directory this script lives in, so paths work from anywhere.
cd "$(dirname "$0")"

PORT=8080
BUILD=0

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    ''|*[!0-9]*) echo "Ignoring unknown argument: $arg" >&2 ;;
    *) PORT="$arg" ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (serve.mjs proxies the articles endpoint)." >&2
  exit 1
fi

# 1. Optionally regenerate the dataset.
if [ "$BUILD" -eq 1 ]; then
  echo "Rebuilding publications.json ..."
  node build-data.mjs
fi

URL="http://localhost:$PORT"
echo "Serving on $URL  (Ctrl+C to stop)"

# 2. Open the browser shortly after the server starts.
( sleep 1
  if command -v open >/dev/null 2>&1; then open "$URL"          # macOS
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" # Linux
  fi
) >/dev/null 2>&1 &

# 3. Serve the folder + /articles proxy.
exec node serve.mjs "$PORT"
