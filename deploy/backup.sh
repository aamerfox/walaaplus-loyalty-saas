#!/usr/bin/env bash
# Nightly database backup for the staging (and later production) stack.
#
#   ./deploy/backup.sh                  # writes one dump, verifies it, prunes old ones
#   BACKUP_DIR=/srv/backups ./deploy/backup.sh
#   COMPOSE_FILE=docker-compose.yml ENV_FILE=.env ./deploy/backup.sh   # against the local stack
#
# Run it from the repository directory on the server. It never takes a password: pg_dump runs
# INSIDE the database container over the local socket, so no credential is passed on a command
# line (where `ps` would show it), written to a file, or echoed.
#
# Three things this script does that a `pg_dump > file` one-liner does not:
#
#   1. pg_dump writes to a file INSIDE the container, not to a pipe. A pipe cannot report a
#      partial write: `pg_dump | cat > file` gives you a truncated file and exit status 0.
#   2. it reads that archive back with `pg_restore --list` before trusting it. An archive whose
#      table of contents cannot be parsed cannot be restored, and tonight is when you want to
#      find that out. (`pg_restore --list` needs a SEEKABLE file, which is the other reason the
#      archive is staged in the container rather than streamed through stdin.)
#   3. it compares a checksum taken inside the container with one taken on the host, so a
#      damaged copy out is caught rather than stored.
#
# It does NOT prove the dump restores to a working database. That is deploy/restore-check.sh,
# which must also run on a schedule - a backup nobody has restored is a hope, not a backup.
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
staged="/tmp/walaaplus-backup-$stamp.dump"

# Remove the staged copy whatever happens, including on failure: the container's filesystem is
# not a place to leave a database dump lying around.
cleanup() { compose exec -T db sh -c "rm -f '$staged'" >/dev/null 2>&1 || true; rm -f "$partial"; }
trap cleanup EXIT

echo "backup: dumping to $final"
# -Fc  custom format: compressed, and the only format pg_restore can filter and reorder.
# The database name comes from the container's own environment, so it is right by construction.
compose exec -T db sh -c "pg_dump -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Fc -f '$staged'"

tables="$(compose exec -T db sh -c "pg_restore --list '$staged' | grep -c 'TABLE DATA'" | tr -d '\r')"
if [ "${tables:-0}" -lt 1 ]; then
  echo "backup: FAILED - the archive lists no table data" >&2
  exit 1
fi

remote_sum="$(compose exec -T db sh -c "sha256sum '$staged'" | awk '{print $1}' | tr -d '\r')"
compose exec -T db sh -c "cat '$staged'" > "$partial"
local_sum="$(sha256sum "$partial" | awk '{print $1}')"

if [ "$remote_sum" != "$local_sum" ]; then
  echo "backup: FAILED - the copy off the container does not match the archive checksum" >&2
  exit 1
fi

mv "$partial" "$final"
chmod 600 "$final"
trap - EXIT
compose exec -T db sh -c "rm -f '$staged'" >/dev/null 2>&1 || true

size="$(du -h "$final" | cut -f1)"
echo "backup: ok - $final ($size, $tables tables with data, sha256 ${local_sum:0:16}...)"

# Prune, newest first. `ls -t` then tail keeps exactly $RETAIN files.
( cd "$BACKUP_DIR" && ls -t walaaplus-*.dump 2>/dev/null | tail -n "+$((RETAIN + 1))" | while read -r old; do
    echo "backup: pruning $old"
    rm -f -- "$old"
  done )

echo "backup: done. Copy $BACKUP_DIR off this host (owner decision C2) and run deploy/restore-check.sh on a schedule."
