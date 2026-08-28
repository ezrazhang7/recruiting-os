#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${BACKUP_SHA256_FILE:=${BACKUP_FILE}.sha256}"
umask 077
test ! -e "$BACKUP_FILE"
test ! -e "$BACKUP_SHA256_FILE"
partial_file="${BACKUP_FILE}.partial.$$"
trap 'rm -f "$partial_file"' EXIT HUP INT TERM
pg_dump --format=custom --no-owner --no-acl --file="$partial_file" "$DATABASE_URL"
pg_restore --list "$partial_file" >/dev/null
checksum=$(sha256sum "$partial_file" | awk '{print $1}')
mv "$partial_file" "$BACKUP_FILE"
printf '%s\n' "$checksum" >"$BACKUP_SHA256_FILE"
trap - EXIT HUP INT TERM
