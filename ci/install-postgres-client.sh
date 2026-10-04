#!/usr/bin/env bash
set -euo pipefail

# PostgreSQL's dump client cannot back up a newer server major. Qualification
# uses PostgreSQL 17, matching the hosted schema target and CI service.
pg_bin=/usr/lib/postgresql/17/bin
if [[ ! -x "${pg_bin}/pg_dump" || ! -x "${pg_bin}/pg_restore" ]]; then
  sudo apt-get update -qq
  sudo apt-get install -y postgresql-client-17
fi
"${pg_bin}/pg_dump" --version | grep -qE 'PostgreSQL\) 17\.'
"${pg_bin}/pg_restore" --version | grep -qE 'PostgreSQL\) 17\.'
test -n "${GITHUB_PATH:?This provisioning script runs in GitHub Actions; use PostgreSQL 17 clients on PATH locally}"
printf '%s\n' "${pg_bin}" >> "${GITHUB_PATH}"
