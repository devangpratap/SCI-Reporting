#!/bin/bash
# sync-db.sh — Wipe local Postgres and re-dump from remote
# Usage: ./scripts/sync-db.sh
# Run this whenever the ingestion team updates the remote DB.

set -e

export PATH="/Applications/Postgres.app/Contents/Versions/latest/bin:$PATH"

REMOTE_URL="postgresql://CurtisIsAlwaysRight:npg_NkTfh4Rlu5tv@ep-wild-sky-d1mz6k1l.database.us-west-2.cloud.databricks.com/databricks_postgres?sslmode=require"
LOCAL_DB="postgres"
LOCAL_HOST="localhost"

echo "==> Dropping existing local data..."
psql -h $LOCAL_HOST $LOCAL_DB -c "
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
" 2>/dev/null

echo "==> Dumping from remote and restoring locally..."
pg_dump "$REMOTE_URL" \
  --data-only \
  --schema=public \
  2>/dev/null | psql -h $LOCAL_HOST $LOCAL_DB

echo "==> Done. Verifying row counts..."
psql -h $LOCAL_HOST $LOCAL_DB -c "
  SELECT 'tasks' AS table, COUNT(*) FROM public.tasks
  UNION ALL
  SELECT 'edges',          COUNT(*) FROM public.edges
  UNION ALL
  SELECT 'identities',     COUNT(*) FROM public.identities
  UNION ALL
  SELECT 'communications', COUNT(*) FROM public.communications
  UNION ALL
  SELECT 'provenance',     COUNT(*) FROM public.provenance;
"

echo "==> Sync complete."
