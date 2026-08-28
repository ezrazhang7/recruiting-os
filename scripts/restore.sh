#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_SHA256_FILE:=${BACKUP_FILE}.sha256}"
: "${RESTORE_CONFIRM:?RESTORE_CONFIRM=RESTORE_TO_EMPTY_DATABASE is required}"
test "$RESTORE_CONFIRM" = "RESTORE_TO_EMPTY_DATABASE"
test -f "$BACKUP_FILE"
test -f "$BACKUP_SHA256_FILE"
expected_checksum=$(tr -d '[:space:]' <"$BACKUP_SHA256_FILE")
actual_checksum=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
test -n "$expected_checksum"
test "$actual_checksum" = "$expected_checksum"
pg_restore --clean --if-exists --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="$DATABASE_URL" "$BACKUP_FILE"
