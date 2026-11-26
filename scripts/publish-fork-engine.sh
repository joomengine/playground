#!/usr/bin/env bash
# Publish only the exact distribution which passed the production Pages smoke.
set -euo pipefail

directory=${1:?Pass the validated static distribution}
id=$(jq -er '.id | select(test("^[a-f0-9]{64}$"))' "$directory/build.json")
jq -e --arg sha "$GITHUB_SHA" --arg run "$GITHUB_RUN_ID" '
  .sourceCommit == $sha and (.engineBuild.runId | tostring) == $run and .runtime.kind == "release"
' "$directory/assets/manifest.json" >/dev/null
archive="engine-$id.tar.gz"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Stable metadata makes interrupted publications safe to repeat.
tar --sort=name --hard-dereference --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' \
  -cf - -C "$directory" . | gzip -n -1 > "$scratch/$archive"
(cd "$scratch" && sha256sum "$archive" > "$archive.sha256")

tag="playground-engine-v1-$id"
repo=(--repo "$GITHUB_REPOSITORY")
if state=$(gh release view "$tag" "${repo[@]}" --json isDraft,assets); then
  if jq -e '.isDraft' <<< "$state" >/dev/null; then
    gh release upload "$tag" "${repo[@]}" "$scratch/$archive" "$scratch/$archive.sha256" --clobber
    gh release edit "$tag" "${repo[@]}" --draft=false --latest=false
  else
    for file in "$archive" "$archive.sha256"; do
      digest=$(sha256sum "$scratch/$file" | cut -d' ' -f1)
      jq -e --arg name "$file" --arg digest "sha256:$digest" \
        'any(.assets[]; .name == $name and .digest == $digest)' <<< "$state" >/dev/null
    done
  fi
else
  # With assets supplied, gh stages them on a draft before publishing the immutable release.
  gh release create "$tag" "${repo[@]}" "$scratch/$archive" "$scratch/$archive.sha256" \
    --target "$GITHUB_SHA" --prerelease --latest=false --title "Playground engine $id" \
    --notes "Verified distribution from production Pages run $GITHUB_RUN_ID."
fi
