#!/usr/bin/env bash
set -euo pipefail
shopt -s nullglob

cache="$HOME/.cache/playground-apt"
mkdir -p "$cache"
# The runner has signed package indexes already. Only reuse archives matching
# the exact package, version, architecture and SHA-256 published in that index.
for archive in "$cache"/*.deb; do
  filename=${archive##*/}
  if [[ "$filename" =~ ^([a-z0-9][a-z0-9.+-]*)_([^_]+)_([a-z0-9-]+)\.deb$ && ! -L "$archive" ]]; then
    name=${BASH_REMATCH[1]}
    version=${BASH_REMATCH[2]//%3a/:}
    arch=${BASH_REMATCH[3]}
    hash=$(sha256sum "$archive")
    if apt-cache show "$name:$arch=$version" 2>/dev/null | sed -n 's/^SHA256: //p' | grep -Fx "${hash%% *}" >/dev/null; then
      sudo install -m 0644 "$archive" "/var/cache/apt/archives/$filename"
      continue
    fi
  fi
  rm -f -- "$archive"
done

# Keep the hosted runner's signed sources and alternate mirrors. Bound each
# transfer attempt and keep the downloaded files for later matrix jobs.
printf '%s\n' 'Acquire::Retries "2";' 'Acquire::http::Timeout "10";' 'Acquire::https::Timeout "10";' \
  'Binary::apt-get::APT::Keep-Downloaded-Packages "true";' | sudo tee /etc/apt/apt.conf.d/99-playground-browser > /dev/null
./node_modules/.bin/playwright install-deps "$PLAYGROUND_BROWSER"
archives=(/var/cache/apt/archives/*.deb)
if (( ${#archives[@]} )); then
  cp -- "${archives[@]}" "$cache/"
  echo 'archives=true' >> "$GITHUB_OUTPUT"
fi
