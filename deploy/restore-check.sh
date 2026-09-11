#!/usr/bin/env bash
# Prove that the newest dump actually restores. Run it on a schedule, not once.
#
#   ./deploy/restore-check.sh                          # newest dump in ./backups
#   ./deploy/restore-check.sh backups/walaaplus-X.dump # a specific one
#   COMPOSE_FILE=docker-compose.yml ENV_FILE=.env ./deploy/restore-check.sh
#
# It restores into a THROWAWAY database beside the live one, inside the same PostgreSQL
# container, counts rows in the tables that matter, and drops the throwaway database again. The
# live database is never written to; the only statements issued outside the throwaway are CREATE
# DATABASE and DROP DATABASE for a name beginning `restorecheck_`.
#
# Why row counts and not "pg_restore exited 0": a dump can restore cleanly and still be useless
# if it was taken from an empty database, or from the wrong one. A restore drill that does not
# look at the data is a drill that passes while the backups are worthless.
#
# This is the agent-written half of owner decision C3. The owner still performs the real drill -
# restoring a dump onto a SEPARATE host and pointing an application at it - before the pilot.
# Running this script is not that drill and does not substitute for it.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
# psql as the owner role on the local socket inside the container: no password anywhere.
q() { compose exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d '$1' -tAc \"$2\"" | tr -d '\r'; }

[ -f "$COMPOSE_FILE" ] || { echo "restore-check: $COMPOSE_FILE not found. Run this from the repository directory." >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "restore-check: $ENV_FILE not found." >&2; exit 2; }

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -t "$BACKUP_DIR"/walaaplus-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$dump" ] && [ -s "$dump" ] || { echo "restore-check: no dump found. Run deploy/backup.sh first." >&2; exit 2; }

scratch="restorecheck_$(date -u +%Y%m%d%H%M%S)"
staged="/tmp/$scratch.dump"
echo "restore-check: restoring $dump into $scratch"

cleanup() {
  compose exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'DROP DATABASE IF EXISTS $scratch'" >/dev/null 2>&1 || true
  compose exec -T db sh -c "rm -f '$staged'" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Stage the archive inside the container. pg_restore needs a seekable file for the custom
# format; feeding it /dev/stdin fails with "did not find magic string in file header".
compose exec -T db sh -c "cat > '$staged'" < "$dump"
compose exec -T db sh -c "psql -U \"\$POSTGRES_USER\" -d postgres -c 'CREATE DATABASE $scratch'" >/dev/null

# --exit-on-error: a restore that reports the first failure and keeps going is how a half-empty
# database gets declared healthy. -j is deliberately absent; a drill is not a race.
if ! compose exec -T db sh -c "pg_restore -U \"\$POSTGRES_USER\" -d $scratch --no-owner --no-privileges --exit-on-error '$staged'"; then
  echo "restore-check: FAILED - pg_restore could not restore this dump" >&2
  exit 1
fi

echo "restore-check: restored. Row counts in the throwaway database:"
status=0
for table in User Business Customer CustomerCard ProgramVersion LoyaltyOperation; do
  exists="$(q "$scratch" "SELECT to_regclass('public.\\\"$table\\\"') IS NOT NULL")"
  if [ "$exists" != "t" ]; then
    printf '  %-18s MISSING\n' "$table"
    status=1
    continue
  fi
  printf '  %-18s %s\n' "$table" "$(q "$scratch" "SELECT count(*) FROM public.\\\"$table\\\"")"
done

if [ "$status" -ne 0 ]; then
  echo "restore-check: FAILED - a core table is missing from the restored database" >&2
  exit 1
fi

# The ledger is the one table whose loss cannot be reconstructed from anywhere else. A dump of a
# live pilot database containing zero operations is not a good backup, it is a warning.
ops="$(q "$scratch" "SELECT count(*) FROM public.\\\"LoyaltyOperation\\\"")"
if [ "${ops:-0}" -eq 0 ]; then
  echo "restore-check: WARNING - the restored ledger is empty. Expected on a fresh staging"
  echo "               database; on a pilot database it means this is not a backup of live data."
fi

echo "restore-check: ok - $dump restores and contains the core tables"
