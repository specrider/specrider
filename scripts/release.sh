#!/usr/bin/env bash
# Assemble a complete release/<version>/ directory from already-built bundles.
#
# Runs the post-build steps the per-platform builds don't do on their own, in
# the one order that's safe:
#
#   1. Verify the macOS .dmg is notarized + stapled. This script does NOT
#      notarize — `pnpm tauri build` leaves the dmg un-notarized, so
#      scripts/notarize-dmg.sh must have run first. We staple-check rather
#      than notarize here because notarization is a slow Apple round-trip
#      with its own script, and staging an un-notarized dmg is the classic
#      Gatekeeper-on-download bug.
#   2. Stage the macOS artifacts (dmg, app.tar.gz, .sig) into release/<version>/.
#      build-linux-docker.sh only stages the Linux half; this is the missing mac half.
#   3. Run scripts/build-linux-docker.sh — builds the Linux bundles in Docker,
#      copies them in, and (because the mac tarball is already staged) writes a
#      complete latest.json with all three platform entries.
#   4. Write SHA256SUMS.txt over the user-facing installers (dmg/AppImage/deb/rpm)
#      — not the .sig files, the .app.tar.gz updater payload, or latest.json.
#
# It deliberately stops there. Tagging, drafting the GitHub Release, smoke-testing
# the updater, and promoting to "Latest" stay manual gates.
#
# Usage:
#   source .env.signing                  # APPLE_API_* + TAURI_SIGNING_* for the Linux step
#   scripts/release.sh [version] [--stage-linux-only]
#
#   version              Defaults to package.json's "version".
#   --stage-linux-only   Forward to build-linux-docker.sh's --stage-only: skip the
#                        Docker rebuild and just copy already-built Linux artifacts.
#                        Handy when re-running assembly after a one-off fix.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

usage() { sed -n '2,33p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; }

stage_linux_only=0
version=""
for arg in "$@"; do
  case "$arg" in
    --stage-linux-only) stage_linux_only=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "error: unknown flag '$arg'" >&2; usage >&2; exit 1 ;;
    *)
      if [[ -n "$version" ]]; then echo "error: unexpected extra argument '$arg'" >&2; exit 1; fi
      version="$arg"
      ;;
  esac
done

version="${version:-$(node -p "require('./package.json').version")}"
release_dir="release/${version}"

bundle="src-tauri/target/release/bundle"
dmg="${bundle}/dmg/SpecRider_${version}_aarch64.dmg"
app_tar="${bundle}/macos/SpecRider.app.tar.gz"

# --- 1. macOS artifacts must exist, and the dmg must be notarized ------------

for f in "$dmg" "$app_tar" "${app_tar}.sig"; do
  [[ -f "$f" ]] || {
    echo "error: missing macOS artifact: $f" >&2
    echo "       run 'pnpm tauri build' on the macOS host first." >&2
    exit 1
  }
done

echo "==> Verifying $dmg is notarized + stapled"
if ! spctl -a -t open --context context:primary-signature "$dmg" >/dev/null 2>&1; then
  echo "error: $dmg is not notarized (spctl rejected it)." >&2
  echo "       run scripts/notarize-dmg.sh first, then re-run this script." >&2
  exit 1
fi
if ! xcrun stapler validate "$dmg" >/dev/null 2>&1; then
  echo "error: $dmg has no stapled notarization ticket." >&2
  echo "       run scripts/notarize-dmg.sh first, then re-run this script." >&2
  exit 1
fi

# --- 2. Stage the macOS artifacts -------------------------------------------

mkdir -p "$release_dir"
cp "$dmg" "$app_tar" "${app_tar}.sig" "$release_dir/"
echo "==> Staged macOS artifacts into $release_dir"

# --- 3. Build + stage Linux, write latest.json ------------------------------

# Pin the child to the same version/dir so the two can never drift apart.
export SPECRIDER_RELEASE_VERSION="$version"
export SPECRIDER_RELEASE_DIR="$release_dir"

linux_args=()
(( stage_linux_only )) && linux_args+=(--stage-only)

echo "==> Building + staging Linux artifacts and writing latest.json (runs Docker)"
# Empty-array-safe expansion: macOS bash 3.2 treats "${arr[@]}" on an empty
# array as an unbound variable under `set -u`.
scripts/build-linux-docker.sh ${linux_args[@]+"${linux_args[@]}"}

# --- 4. Checksums over the user-facing installers ---------------------------

# Cover only what users download and verify: dmg/AppImage/deb/rpm. Excludes the
# .sig files, the .app.tar.gz updater payload, and latest.json — matching the
# shape of prior releases' SHA256SUMS.txt.
echo "==> Writing SHA256SUMS.txt"
(
  cd "$release_dir"
  : > SHA256SUMS.txt
  for pat in \
    SpecRider_*_aarch64.dmg \
    SpecRider_*_amd64.AppImage \
    SpecRider_*_amd64.deb \
    SpecRider-*.x86_64.rpm
  do
    for f in $pat; do
      [[ -f "$f" ]] && shasum -a 256 "$f" >> SHA256SUMS.txt
    done
  done
)

echo
echo "Release assembled in $release_dir:"
ls -1 "$release_dir"
