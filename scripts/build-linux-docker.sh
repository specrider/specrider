#!/usr/bin/env bash
# Build Linux release artifacts from macOS using OrbStack/Docker.
#
# Produces AppImage/deb/rpm artifacts under src-tauri/target/release/bundle,
# copies them to release/<version>/, and regenerates latest.json when the
# release directory has enough updater artifacts. The AppImage updater tarball
# is signed with the Tauri updater key mounted read-only into the container.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

stage_only=0
if [[ "${1:-}" == "--stage-only" ]]; then
  stage_only=1
  shift
fi

if [[ -f .env.signing ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.signing
  set +a
fi

: "${TAURI_SIGNING_PRIVATE_KEY_PATH:?TAURI_SIGNING_PRIVATE_KEY_PATH must be set in .env.signing or the environment}"

if [[ ! -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]]; then
  echo "error: TAURI_SIGNING_PRIVATE_KEY_PATH does not exist: $TAURI_SIGNING_PRIVATE_KEY_PATH" >&2
  exit 1
fi

image="${SPECRIDER_LINUX_BUILDER_IMAGE:-specrider-linux-builder:bookworm}"
platform="${SPECRIDER_LINUX_BUILDER_PLATFORM:-linux/amd64}"
version="${SPECRIDER_RELEASE_VERSION:-$(node -p "require('./package.json').version")}"
release_dir="${SPECRIDER_RELEASE_DIR:-release/${version}}"

if (( stage_only == 0 )); then
  docker build \
    --platform "$platform" \
    -f docker/linux-release.Dockerfile \
    -t "$image" \
    .

  docker run --rm \
    --platform "$platform" \
    -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -e TAURI_SIGNING_PRIVATE_KEY_PATH=/run/secrets/tauri-updater.key \
    -e TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" \
    -v "$repo_root":/work \
    -v "$TAURI_SIGNING_PRIVATE_KEY_PATH":/run/secrets/tauri-updater.key:ro \
    -v specrider-linux-node-modules:/work/node_modules \
    -v specrider-linux-cargo-registry:/usr/local/cargo/registry \
    -v specrider-linux-cargo-git:/usr/local/cargo/git \
    -w /work \
    "$image" \
    bash -lc 'export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")" && pnpm install --frozen-lockfile && pnpm tauri build --bundles appimage,deb,rpm'
fi

mkdir -p "$release_dir"

artifacts_file="$(mktemp)"
find src-tauri/target/release/bundle -maxdepth 3 -type f \
  \( -name "*.AppImage" -o -name "*.AppImage.sig" -o -name "*.AppImage.tar.gz" -o -name "*.AppImage.tar.gz.sig" -o -name "*.deb" -o -name "*.deb.sig" -o -name "*.rpm" -o -name "*.rpm.sig" \) \
  -print | sort > "$artifacts_file"

if [[ ! -s "$artifacts_file" ]]; then
  rm -f "$artifacts_file"
  echo "error: no Linux release artifacts found under src-tauri/target/release/bundle" >&2
  exit 1
fi

while IFS= read -r artifact; do
  cp "$artifact" "$release_dir/"
done < "$artifacts_file"

echo "copied Linux artifacts to $release_dir:"
sed 's#.*/#  #' "$artifacts_file"
rm -f "$artifacts_file"

if [[ -x scripts/build-update-manifest.sh ]]; then
  if scripts/build-update-manifest.sh "$version" "$release_dir"; then
    :
  else
    echo "warning: latest.json was not regenerated. If this was a partial platform build, rerun:" >&2
    echo "  scripts/build-update-manifest.sh $version $release_dir --allow-partial" >&2
  fi
fi
