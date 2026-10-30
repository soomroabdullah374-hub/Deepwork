#!/usr/bin/env bash
# Rebuild a local test database from db/*.sql and run every db/tests suite as the
# non-owner API and dispatcher roles, exactly as RLS sees them in production.
set -euo pipefail
cd "$(dirname "$0")/.."
scripts/pg-local.sh
P="psql -h /tmp -p 55432 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists deepwork_test"
for r in deepwork_api deepwork_worker; do $P -c "drop role if exists $r"; done
for r in authenticated dispatcher; do
  if [ "$($P -tAc "select 1 from pg_roles where rolname = '$r'")" = "1" ]; then
    $P -c "drop owned by $r" -c "drop role $r"
  fi
done
$P -c "create database deepwork_test"
$P -d deepwork_test -f db/schema.sql
$P -d deepwork_test -f db/functions.sql
$P -d deepwork_test -f db/api.sql
$P -d deepwork_test -c "create role deepwork_api login password 'test' in role authenticated" \
                    -c "create role deepwork_worker login password 'test' in role dispatcher"
run() { psql -h /tmp -p 55432 -U "$1" -d deepwork_test -v ON_ERROR_STOP=1 -q -f "$2" 2>&1 | grep -E "NOTICE|ERROR|FAIL" | sed -E 's/^psql:[^:]+:[0-9]+: //'; }
run deepwork_api db/tests/db_test.sql
run deepwork_api db/tests/api_test.sql
psql -h /tmp -p 55432 -U deepwork_api -d deepwork_test -v ON_ERROR_STOP=1 -q -f db/tests/worker_fixtures.sql >/dev/null
run deepwork_worker db/tests/worker_test.sql
