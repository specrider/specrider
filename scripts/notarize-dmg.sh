#!/usr/bin/env bash
# Notarize + staple the macOS .dmg.
#
# `pnpm tauri build` code-signs, notarizes, and staples the .app, and
# code-signs the .dmg — but it does NOT notarize the .dmg. Since the dmg is
# the artifact users download, an un-notarized dmg trips Gatekeeper on the
# disk image itself. This script closes that gap: submit the dmg to Apple's
# notary service, wait for the ticket, staple it, and verify.
#
# Usage:
#   source .env.signing            # provides APPLE_API_* (App Store Connect key)
#   scripts/notarize-dmg.sh [path/to/SpecRider_*.dmg]
#
# With no argument it finds the dmg under src-tauri/target/release/bundle/dmg/.
set -euo pipefail

: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER (source .env.signing)}"
: "${APPLE_API_KEY:?set APPLE_API_KEY (App Store Connect key id)}"
: "${APPLE_API_KEY_PATH:?set APPLE_API_KEY_PATH (path to AuthKey_*.p8)}"

dmg="${1:-}"
if [[ -z "$dmg" ]]; then
  dmg=$(ls -t src-tauri/target/release/bundle/dmg/SpecRider_*.dmg 2>/dev/null | head -1 || true)
fi
[[ -n "$dmg" && -f "$dmg" ]] || { echo "error: dmg not found: ${dmg:-<none>}" >&2; exit 1; }

echo "Notarizing $dmg ..."
xcrun notarytool submit "$dmg" \
  --issuer "$APPLE_API_ISSUER" \
  --key-id "$APPLE_API_KEY" \
  --key    "$APPLE_API_KEY_PATH" \
  --wait

echo "Stapling ..."
xcrun stapler staple "$dmg"

echo "Verifying ..."
spctl -a -t open --context context:primary-signature -vv "$dmg"
xcrun stapler validate "$dmg"
echo "OK: $dmg is notarized and stapled."
