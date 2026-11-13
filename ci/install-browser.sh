#!/usr/bin/env bash
set -euo pipefail

# The hosted runner also configures Google's system Chrome repository. These
# tests use Playwright's pinned Chromium download, not that system package.
# Exclude the unused repository so its index publication/hash failures cannot
# block installation of Chromium's Ubuntu dependencies. Apt verification stays on.
sudo rm -f /etc/apt/sources.list.d/google-chrome.list /etc/apt/sources.list.d/google-chrome.sources
browsers=("$@")
if ((${#browsers[@]} == 0)); then browsers=(chromium); fi

# The browsers' Ubuntu packages are installed here, under bounds of our own.
# `playwright install --with-deps` runs apt with none: on 26 October one
# runner's mirror stopped answering mid-index, and apt waited out the job's
# whole install budget in silence. A connection now gives up after 20 seconds
# of silence and is retried, every apt step that only reads the network has a
# wall clock and is retried, and the packages are fetched before they are
# installed, so that what a retry cuts short is a download, never dpkg. The
# list of packages is Playwright's own, read from its dry run, and the dry run
# then has to report nothing missing.
echo 'Acquire::Retries "3"; Acquire::http::Timeout "20"; Acquire::https::Timeout "20";' |
  sudo tee /etc/apt/apt.conf.d/99nebula-network > /dev/null
bounded() {
  local tries=$1 seconds=$2 attempt
  shift 2
  for ((attempt = 1; attempt <= tries; attempt++)); do
    if timeout --kill-after=10 "$seconds" "$@"; then return 0; fi
    echo "attempt ${attempt} of ${tries} failed or passed ${seconds}s: $*" >&2
    sleep $((attempt * 5))
  done
  return 1
}
missing() {
  npx playwright install-deps --dry-run "${browsers[@]}" | sed -n 's/^  \([^ ]\+\)$/\1/p' || true
}
bounded 3 150 sudo apt-get update
mapfile -t packages < <(missing)
if ((${#packages[@]})); then
  echo "installing ${#packages[@]} system packages for ${browsers[*]}"
  bounded 3 240 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --download-only "${packages[@]}"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${packages[@]}"
fi
bounded 2 300 npx playwright install "${browsers[@]}"
npx playwright install-deps --dry-run "${browsers[@]}"
