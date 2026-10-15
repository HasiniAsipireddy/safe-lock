#!/bin/bash
# Creates the vitest database alongside the dev one.
#
# Runs only on first start, when the named volume is still empty. To re-run it:
#   docker compose down -v && docker compose up -d
#
# This file must keep LF line endings — the container's bash cannot execute a
# script with CRLF line endings.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE safelock_test OWNER $POSTGRES_USER;
EOSQL

echo "init-test-db.sh: created database safelock_test"
