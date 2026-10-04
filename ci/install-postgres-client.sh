#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL's dump client cannot back up a newer server major. Qualification
# uses PostgreSQL 17, matching the hosted schema target and CI service.
test -n "${GITHUB_PATH:?This provisioning script runs in GitHub Actions; use PostgreSQL 17 clients on PATH locally}"
# Ubuntu 24.04's default repository provides PostgreSQL 16. Use PGDG's signed
# packages for this explicitly supported runner, never a mismatched dump client.
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 24.04 || "${VERSION_CODENAME:-}" != noble ]]; then
  printf '%s\n' 'PostgreSQL client provisioning requires Ubuntu 24.04 (noble).' >&2
  exit 1
fi
pg_bin=/usr/lib/postgresql/17/bin
if [[ ! -x "${pg_bin}/pg_dump" || ! -x "${pg_bin}/pg_restore" ]]; then
  key_directory="$(mktemp -d)"
  trap 'rm -rf -- "${key_directory}"' EXIT
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --retry 3 --connect-timeout 15 --max-time 60 \
    --output "${key_directory}/pgdg.asc" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  key_fingerprints="$(gpg --batch --homedir "${key_directory}" --with-colons \
    --show-keys "${key_directory}/pgdg.asc" | \
    awk -F: '$1 == "pub" { primary = 1; next } primary && $1 == "fpr" { print $10; primary = 0 }')"
  if [[ "${key_fingerprints}" != B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8 ]]; then
    printf '%s\n' 'PostgreSQL repository signing-key fingerprint does not match.' >&2
    exit 1
  fi
  gpg --batch --homedir "${key_directory}" --dearmor \
    --output "${key_directory}/pgdg.gpg" "${key_directory}/pgdg.asc"
  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "${key_directory}/pgdg.gpg" /etc/apt/keyrings/nebulaverse-pgdg.gpg
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nebulaverse-pgdg.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main' | \
    sudo tee /etc/apt/sources.list.d/nebulaverse-pgdg.list > /dev/null
  sudo apt-get update -qq --error-on=any
  sudo apt-get install -y postgresql-client-17
fi
"${pg_bin}/pg_dump" --version | grep -qE 'PostgreSQL\) 17\.'
"${pg_bin}/pg_restore" --version | grep -qE 'PostgreSQL\) 17\.'
printf '%s\n' "${pg_bin}" >> "${GITHUB_PATH}"
