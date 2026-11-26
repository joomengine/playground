#!/usr/bin/env bash
# Publish only the exact distribution which passed the production Pages smoke.
set -euo pipefail

directory=${1:?Pass the validated static distribution}
tag=playground-engine-v1
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

if ! gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --prerelease --latest=false \
    --title "Playground engine for downstream sites" \
    --notes "Verified compiled Playground distributions for the fork Pages workflow. The public Playground build identity selects the current asset."
fi

release_id=$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$tag" --jq '.id')
assets() {
  gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases/$release_id/assets?per_page=100" | jq 'add'
}
existing=$(assets)
# The checksum is the readiness signal. Publish it only after the complete engine exists.
for file in "$archive" "$archive.sha256"; do
  record=$(jq -c --arg name "$file" '.[] | select(.name == $name)' <<< "$existing")
  if [[ -n "$record" && $(jq -r '.state' <<< "$record") == starter ]]; then
    gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$(jq -r '.id' <<< "$record")"
    record=''
  fi
  if [[ -z "$record" ]]; then
    gh release upload "$tag" "$scratch/$file" --repo "$GITHUB_REPOSITORY"
  else
    digest=$(sha256sum "$scratch/$file" | cut -d' ' -f1)
    jq -e --arg digest "sha256:$digest" '.state == "uploaded" and .digest == $digest' <<< "$record" >/dev/null
  fi
done

# Keep three completed engines. Never touch other assets, tags or releases.
inventory=$(assets)
stale=$(jq -r --arg current "$archive" '
  [.[] | select(.state == "uploaded" and (.name | test("^engine-[a-f0-9]{64}\\.tar\\.gz\\.sha256$")))
   | {archive: (.name | sub("\\.sha256$"; "")), created_at}]
  | map(select(.archive != $current)) | sort_by(.created_at) | reverse | .[2:][].archive
' <<< "$inventory")
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  for file in "$old.sha256" "$old"; do
    asset_id=$(jq -r --arg name "$file" '.[] | select(.name == $name) | .id' <<< "$inventory")
    if [[ -n "$asset_id" ]]; then gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/assets/$asset_id"; fi
  done
done <<< "$stale"
