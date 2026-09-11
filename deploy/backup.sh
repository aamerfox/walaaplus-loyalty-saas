#!/usr/bin/env bash
# Nightly database backup for the staging (and later production) stack.
#
#   ./deploy/backup.sh                  # writes one dump, prunes old ones
#   BACKUP_DIR=/srv/backups ./deploy/backup.sh
#
# Run it from the repository directory on the server. It never takes a password: pg_dump runs
# INSIDE the database container over the local socket, so no credential is passed on a command
# line (where `ps` would show it), written to a file, or echoed.
#
# Two things this script does that a `pg_dump > file` one-liner does not:
#
#   1. it writes to a temporary name and renames only on success, so an interrupted run can
#      never leave a truncated file that looks like a backup;
#   2. it reads the finished dump back with `pg_restore --list`. A dump that cannot be listed
#      cannot be restored, and finding that out tonight is the entire point.
#
# It does NOT prove the dump restores to a working database. That is deploy/restore-check.sh,
# which must be run on a schedule too - a backup nobody has restored is a hope, not a backup.
#
# Where dumps are ultimately stored, and who owns the restore, is owner decision C2/C3. This
# script writes to a local directory; copying that directory off the host is the owner's step and
# is deliberately not automated here, because it needs a credential the agent must never hold.
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.staging.yml}"
ENV_FILE="${ENV_FILE:-.env.staging}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETAIN="${RETAIN:-30}"

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

[ -f "$COMPOSE_FILE" ] || { echo "backup: $COMPOSE_FILE not found. Run this from the repository directory." >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "backup: $ENV_FILE not found." >&2; exit 2; }

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/walaaplus-$stamp.dump"
partial="$final.partial"

echo "backup: dumping to $final"
# -Fc  custom format: compressed, and the only format pg_restore can filter and reorder.
# The database name comes from the container's own environment, so it is right by construction.
compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$partial"

if [ ! -s "$partial" ]; then
  rm -f "$partial"
  echo "backup: FAILED - the dump is empty" >&2
  exit 1
fi

# Read it back. `pg_restore --list` parses the archive's table of contents; it fails on a
# truncated or corrupt file. Run inside the container so the tool version matches the server's.
tables="$(compose exec -T db sh -c 'pg_restore --list /dev/stdin' < "$partial" | grep -c 'TABLE DATA' || true)"
if [ "$tables" -lt 1 ]; then
  rm -f "$partial"
  echo "backup: FAILED - the dump lists no table data" >&2
  exit 1
fi

mv "$partial" "$final"
chmod 600 "$final"
size="$(du -h "$final" | cut -f1)"
echo "backup: ok - $final ($size, $tables tables with data)"

# Prune, newest first. `ls -t` then tail: keeps exactly $RETAIN files.
cd "$BACKUP_DIR"
ls -t walaaplus-*.dump 2>/dev/null | tail -n "+$((RETAIN + 1))" | while read -r old; do
  echo "backup: pruning $old"
  rm -f -- "$old"
done

echo "backup: done. Copy $BACKUP_DIR off this host (owner decision C2) and run deploy/restore-check.sh on a schedule."
