#!/usr/bin/env bash
set -euo pipefail

# The browsers' system packages, kept between runs.
#
# ci/install-browser.sh has apt download the Ubuntu packages Chromium and
# WebKit need -- about 120 MB for both -- on every run. A slow
# mirror once spent a job's whole install budget on them: it served its signed
# indexes at 10 MB/s and the packages at 150 KB/s. The workflow keeps what apt
# downloaded in the Actions cache and puts it back in apt's own archive before
# the next install. apt checks every archived package against the signed index
# it has just fetched and downloads again whatever does not match, so a kept
# package is only ever a download skipped, never a package taken on the
# cache's word.
#
#   restore <dir>            put the kept packages in apt's archive, and have
#                            apt keep what it downloads from now on
#   collect <dir> <prefix>   replace <dir> with apt's archive, less what the
#                            index no longer offers, and name it for the cache
#                            as <prefix><digest of the package file names>; an
#                            unchanged set gets the name it was restored under
usage() { echo "usage: $0 restore <dir> | collect <dir> <prefix>" >&2; exit 2; }
archive=/var/cache/apt/archives
command="${1:-}"
dir="${2:-}"
[[ -n "$dir" ]] || usage
shopt -s nullglob
export LC_ALL=C

case "$command" in
  restore)
    echo 'APT::Keep-Downloaded-Packages "true";' | sudo tee /etc/apt/apt.conf.d/99nebula-keep-packages > /dev/null
    kept=("$dir"/*.deb)
    if ((${#kept[@]})); then sudo cp -- "${kept[@]}" "$archive"/; fi
    echo "restored ${#kept[@]} kept packages into apt's archive"
    ;;
  collect)
    prefix="${3:-}"
    [[ -n "$prefix" ]] || usage
    # Versions the index no longer offers would only grow the cache.
    sudo apt-get autoclean -qq || echo "apt-get autoclean failed; keeping the archive as it is"
    rm -rf -- "$dir"
    mkdir -p -- "$dir"
    downloaded=("$archive"/*.deb)
    if ((${#downloaded[@]} == 0)); then
      echo "apt's archive holds no packages to keep"
      exit 0
    fi
    cp -- "${downloaded[@]}" "$dir"/
    digest=$(cd -- "$dir" && printf '%s\n' *.deb | sha256sum | cut -c1-16)
    echo "keeping ${#downloaded[@]} packages as ${prefix}${digest}"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo "key=${prefix}${digest}" >> "$GITHUB_OUTPUT"; fi
    ;;
  *) usage ;;
esac
