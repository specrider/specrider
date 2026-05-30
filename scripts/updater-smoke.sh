#!/usr/bin/env bash
# Manually-run smoke test for the auto-updater wire.
#
# What this verifies:
#   1. The `tauri-plugin-updater` plugin is registered.
#   2. The capability grant reaches the main window.
#   3. The plugin can pull a `latest.json` from the configured endpoint
#      and surface an "update available" decision to the JS side.
#
# What this DOES NOT verify:
#   - Signature verification — placeholder `.sig` strings would fail
#     verification at install time. The smoke check stops at the
#     `check()` step before signing is exercised.
#   - The actual download + install path. Full upgrade verification
#     against a real signed build is a separate end-to-end procedure.
#
# How it works:
#   1. Writes a fake `latest.json` claiming version 99.99.99 to a
#      temporary directory.
#   2. Starts `python3 -m http.server` in that directory on an
#      ephemeral port. The updater plugin uses reqwest under the hood,
#      and reqwest only supports http/https — `file://` URLs raise a
#      "builder error for url" so we serve over loopback HTTP.
#   3. Launches `pnpm tauri dev --config` with an overlay that points
#      the updater endpoint at the local server and sets
#      `dangerousInsecureTransportProtocol: true` (required because
#      the plugin refuses non-https endpoints by default).
#
# How you verify:
#   With the dev window open, open DevTools and run:
#     const { check } = await import('@tauri-apps/plugin-updater');
#     console.log(await check());
#   Expected:
#     Update { version: "99.99.99", currentVersion: "...", ... }
#
# Cleanup is automatic on exit: the manifest dir is removed and the
# HTTP server is killed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAKE_VERSION="99.99.99"
SERVE_DIR="$(mktemp -d -t specrider-updater-smoke.XXXXXX)"
MANIFEST_PATH="$SERVE_DIR/latest.json"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$SERVE_DIR"
}
trap cleanup EXIT INT TERM

# Minimal-but-valid v2 manifest. The `signature` and `url` placeholders
# would only get hit if the test code calls download/install; the smoke
# check stops at `check()` returning a non-null Update object.
cat >"$MANIFEST_PATH" <<EOF
{
  "version": "$FAKE_VERSION",
  "notes": "Updater smoke test — not a real release.",
  "pub_date": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "platforms": {
    "darwin-aarch64": {
      "signature": "PLACEHOLDER_NOT_A_REAL_SIGNATURE",
      "url": "http://localhost:0/placeholder.app.tar.gz"
    },
    "linux-x86_64": {
      "signature": "PLACEHOLDER_NOT_A_REAL_SIGNATURE",
      "url": "http://localhost:0/placeholder.AppImage.tar.gz"
    }
  }
}
EOF

# Start an http server on an ephemeral port. python3 picks the port
# itself when given 0; we read it back from the bind log.
PORT_FILE="$(mktemp)"
python3 -c "
import http.server, socketserver, os, sys
os.chdir('$SERVE_DIR')
with socketserver.TCPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler) as srv:
    port = srv.server_address[1]
    open('$PORT_FILE','w').write(str(port))
    srv.serve_forever()
" &
SERVER_PID=$!

# Wait briefly for the server to write its port. Bound by a small loop
# instead of a fixed sleep so we don't add startup latency.
for _ in $(seq 1 30); do
  if [[ -s "$PORT_FILE" ]]; then
    break
  fi
  sleep 0.1
done

if [[ ! -s "$PORT_FILE" ]]; then
  echo "error: http server failed to start" >&2
  exit 1
fi

PORT="$(<"$PORT_FILE")"
rm -f "$PORT_FILE"
ENDPOINT="http://127.0.0.1:${PORT}/latest.json"

CONFIG_OVERLAY=$(cat <<EOF
{
  "plugins": {
    "updater": {
      "endpoints": ["$ENDPOINT"],
      "dangerousInsecureTransportProtocol": true
    }
  }
}
EOF
)

cat <<EOF
Fake manifest:    $MANIFEST_PATH
Serving on:       $ENDPOINT
Endpoint override: $ENDPOINT

Launching pnpm tauri dev with overlay config. Once the window paints,
open DevTools and run:

  const { check } = await import('@tauri-apps/plugin-updater');
  console.log(await check());

Expected: an Update object with version "$FAKE_VERSION".
Within ~30s of the window opening, the title-bar chip should appear too.
Ctrl+C to stop (cleans up the server + temp dir).
EOF

cd "$REPO_ROOT"
exec pnpm tauri dev --config "$CONFIG_OVERLAY"
