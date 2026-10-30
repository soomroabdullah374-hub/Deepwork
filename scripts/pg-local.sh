#!/usr/bin/env bash
# Start (or reuse) a throwaway local PostgreSQL 16 on port 55432 for the db/tests suite.
set -euo pipefail
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PGDATA_DIR:-/var/lib/postgresql/deepwork-test}
if ! pg_isready -h /tmp -p 55432 -q 2>/dev/null; then
  if [ ! -f "$DATA/PG_VERSION" ]; then
    mkdir -p "$DATA" && chown postgres:postgres "$DATA"
    su postgres -c "$PGBIN/initdb -D $DATA -A trust -U postgres" >/dev/null
  fi
  rm -f "$DATA/postmaster.pid"
  su postgres -c "$PGBIN/pg_ctl -D $DATA -o '-p 55432 -k /tmp' -l $DATA/log.txt start" >/dev/null
  for _ in $(seq 1 20); do pg_isready -h /tmp -p 55432 -q && break; sleep 0.5; done
fi
echo "postgres ready on /tmp:55432"
