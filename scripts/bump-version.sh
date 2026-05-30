#!/usr/bin/env bash
# Bump SpecRider's version across the three files that carry it:
# package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json.
#
# Uses regex edits rather than JSON/TOML round-tripping so the rest of
# the file's formatting (inline objects, comments, key order) is left
# untouched.
#
# Usage: scripts/bump-version.sh <version>
# Example: scripts/bump-version.sh 0.2.0
#          scripts/bump-version.sh 0.2.0-rc.1

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 0.2.0" >&2
  exit 1
fi

version="$1"

if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$version' is not a valid semver string (e.g. 0.2.0 or 0.2.0-rc.1)" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

verify_one_match() {
  local file="$1"; local pattern="$2"
  local count
  count=$(grep -cE "$pattern" "$file" || true)
  if [[ "$count" -ne 1 ]]; then
    echo "Error: expected exactly 1 version match in $file, found $count" >&2
    echo "(pattern: $pattern)" >&2
    exit 1
  fi
}

# Guard: each file must contain exactly one match for its version pattern.
# If a future change adds another, the script aborts rather than silently
# bumping the wrong field.
verify_one_match package.json '"version"[[:space:]]*:[[:space:]]*"[^"]*"'
verify_one_match src-tauri/tauri.conf.json '"version"[[:space:]]*:[[:space:]]*"[^"]*"'
verify_one_match src-tauri/Cargo.toml '^version[[:space:]]*=[[:space:]]*"[^"]*"'

V="$version" perl -i -pe 's/("version"\s*:\s*)"[^"]*"/$1"$ENV{V}"/' package.json
V="$version" perl -i -pe 's/("version"\s*:\s*)"[^"]*"/$1"$ENV{V}"/' src-tauri/tauri.conf.json
V="$version" perl -i -pe 's/^(version\s*=\s*)"[^"]*"/$1"$ENV{V}"/' src-tauri/Cargo.toml

echo "Bumped to $version in:"
echo "  package.json"
echo "  src-tauri/tauri.conf.json"
echo "  src-tauri/Cargo.toml"
echo
echo "Verify:"
echo "  grep '\"version\"' package.json src-tauri/tauri.conf.json"
echo "  grep -E '^version' src-tauri/Cargo.toml"
