#!/usr/bin/env bash
# Compose the Tauri 2 updater manifest (`latest.json`) for a release.
#
# Scans <artifact-dir> for updater-eligible bundles produced by
# `pnpm tauri build` (when `TAURI_SIGNING_PRIVATE_KEY` is exported),
# reads the sibling `.sig` files, and writes the platform-keyed manifest
# at `<artifact-dir>/latest.json`.
#
# This script DOES NOT sign — `tauri build` does. Splitting the steps
# avoids key-environment drift between build and packaging, and keeps
# the signing key from leaking into the manifest CI flow.
#
# Expected artifacts:
#   - *.app.tar.gz                  + .sig (macOS universal)
#   - *_amd64.AppImage              + .sig (Linux x86_64)
#
# Strict mode (default): errors out if fewer than the two expected
# platforms are present. Pass `--allow-partial` for staged builds where
# only one platform's artifacts have landed in <artifact-dir> yet.
#
# Windows is not yet handled by this script. The app currently directs
# Windows users to GitHub Releases for manual installs instead of using
# the updater plugin for in-app installs.
#
# Usage:
#   scripts/build-update-manifest.sh <version> <artifact-dir> [--notes-file <path>] [--allow-partial]
#
# Example:
#   scripts/build-update-manifest.sh 0.2.0 ./release-staging/

set -euo pipefail

REPO_OWNER="specrider"
REPO_NAME="specrider"

usage() {
  cat <<'EOF' >&2
Usage: build-update-manifest.sh <version> <artifact-dir> [options]
  <version>            Semver without leading 'v' (e.g. 0.2.0, 0.2.0-rc.1).
  <artifact-dir>       Directory containing per-platform updater bundles
                       (*.app.tar.gz, *_amd64.AppImage) + .sig siblings.

Options:
  --notes-file <path>  Markdown release notes to inline into the manifest's
                       `notes` field. Default: a link back to the GitHub
                       release page.
  --allow-partial      Don't error when fewer than 2 platforms are found.
                       Useful for macOS-only or intermediate staging while
                       platform builds are still landing.
EOF
}

if [[ $# -lt 2 ]]; then
  usage
  exit 1
fi

VERSION="$1"
ARTIFACT_DIR="$2"
shift 2

NOTES_FILE=""
ALLOW_PARTIAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes-file)
      [[ $# -lt 2 ]] && { echo "error: --notes-file requires an argument" >&2; exit 1; }
      NOTES_FILE="$2"
      shift 2
      ;;
    --allow-partial)
      ALLOW_PARTIAL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

# --- Validate inputs ---------------------------------------------------------

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: version '$VERSION' is not semver-shaped" >&2
  exit 1
fi

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "error: artifact directory '$ARTIFACT_DIR' is not a directory" >&2
  exit 1
fi

# --- Read a .sig file with shape validation ---------------------------------

read_sig() {
  local tar="$1"
  local sig="${tar}.sig"
  if [[ ! -f "$sig" ]]; then
    echo "error: $tar is missing its signature ($sig)" >&2
    echo "       re-run 'pnpm tauri build' with TAURI_SIGNING_PRIVATE_KEY set on the build host." >&2
    exit 1
  fi
  # `tauri signer sign` emits the signature as a single base64-encoded
  # line. Real signatures land around 200–300 chars; refuse anything
  # outside a generous window so an empty or truncated file fails loud.
  local content
  content="$(<"$sig")"
  content="${content//[$'\r\n']}"
  if [[ -z "$content" ]]; then
    echo "error: signature file $sig is empty" >&2
    exit 1
  fi
  local len=${#content}
  if (( len < 100 || len > 800 )); then
    echo "error: signature file $sig length ($len) outside expected 100–800 char range — likely corrupt" >&2
    exit 1
  fi
  if ! [[ "$content" =~ ^[A-Za-z0-9+/=]+$ ]]; then
    echo "error: signature file $sig is not a raw base64 signature — likely contains signer log output" >&2
    echo "       regenerate it with: tauri signer sign -f <key> <artifact>" >&2
    exit 1
  fi
  printf '%s' "$content"
}

# --- Discover artifacts -------------------------------------------------------

# Use `find` (not glob) so an empty directory doesn't trip nullglob/failglob.
MAC_TAR="$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*.app.tar.gz' -print -quit 2>/dev/null || true)"
APPIMAGE="$(find "$ARTIFACT_DIR" -maxdepth 1 -name '*_amd64.AppImage' -print -quit 2>/dev/null || true)"

PLATFORMS_FOUND=0
declare -a PLATFORM_KEYS PLATFORM_FILES PLATFORM_SIGS

add_platform() {
  local key="$1" tar="$2"
  local sig
  sig="$(read_sig "$tar")"
  PLATFORM_KEYS+=("$key")
  PLATFORM_FILES+=("$(basename "$tar")")
  PLATFORM_SIGS+=("$sig")
  PLATFORMS_FOUND=$((PLATFORMS_FOUND + 1))
}

# We ship macOS as a universal app bundle, so the same updater tarball
# serves both Apple Silicon and Intel clients.
if [[ -n "$MAC_TAR" ]]; then
  add_platform "darwin-aarch64" "$MAC_TAR"
  add_platform "darwin-x86_64" "$MAC_TAR"
fi
if [[ -n "$APPIMAGE" ]]; then add_platform "linux-x86_64" "$APPIMAGE"; fi

if (( PLATFORMS_FOUND == 0 )); then
  echo "error: no updater-eligible bundles found in '$ARTIFACT_DIR'" >&2
  echo "       expected: *.app.tar.gz and/or *_amd64.AppImage" >&2
  exit 1
fi

EXPECTED_PLATFORMS=3
if (( PLATFORMS_FOUND < EXPECTED_PLATFORMS && ALLOW_PARTIAL == 0 )); then
  echo "error: only ${PLATFORMS_FOUND}/${EXPECTED_PLATFORMS} platform bundles found in '$ARTIFACT_DIR'." >&2
  echo "       pass --allow-partial to write a partial manifest, or copy the missing platform's" >&2
  echo "       artifacts in and re-run. Found: ${PLATFORM_KEYS[*]}" >&2
  exit 1
fi

# --- Compose latest.json ----------------------------------------------------

PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DEFAULT_NOTES="See https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/v${VERSION}"

if [[ -n "$NOTES_FILE" ]]; then
  if [[ ! -f "$NOTES_FILE" ]]; then
    echo "error: --notes-file '$NOTES_FILE' not found" >&2
    exit 1
  fi
  NOTES_BODY="$(<"$NOTES_FILE")"
else
  NOTES_BODY="$DEFAULT_NOTES"
fi

OUT="${ARTIFACT_DIR%/}/latest.json"

# Hand the data off to python3 for JSON serialization — it's installed
# everywhere we build (macOS, Ubuntu LTS, build hosts) and gives us
# correct string escaping for `notes` without inventing our own escaper.
python3 - "$VERSION" "$PUB_DATE" "$NOTES_BODY" "$REPO_OWNER" "$REPO_NAME" "$OUT" \
  "${PLATFORM_KEYS[@]}" "::" "${PLATFORM_FILES[@]}" "::" "${PLATFORM_SIGS[@]}" <<'PY'
import json
import sys

version, pub_date, notes, owner, repo, out_path = sys.argv[1:7]
rest = sys.argv[7:]

def split_on_sep(items, sep="::"):
    out, cur = [], []
    for item in items:
        if item == sep:
            out.append(cur)
            cur = []
        else:
            cur.append(item)
    out.append(cur)
    return out

keys, files, sigs = split_on_sep(rest)
assert len(keys) == len(files) == len(sigs), (
    f"platform list lengths mismatch: keys={len(keys)} files={len(files)} sigs={len(sigs)}"
)

platforms = {}
for key, fname, sig in zip(keys, files, sigs):
    url = f"https://github.com/{owner}/{repo}/releases/download/v{version}/{fname}"
    platforms[key] = {"signature": sig, "url": url}

manifest = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": platforms,
}

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

echo "wrote $OUT" >&2
echo "  version:    $VERSION" >&2
echo "  pub_date:   $PUB_DATE" >&2
echo "  platforms:  ${PLATFORM_KEYS[*]}" >&2
