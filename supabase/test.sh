#!/usr/bin/env bash
# Runs real PostgreSQL RLS tests in a temporary container; no ports exposed.
set -euo pipefail
cd "$(dirname "$0")/.."
container_name="lexora-db-test-$$"
cleanup(){ docker rm -f "$container_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Pin to a digest so repeated tests use the same verified PostgreSQL image.
docker run -d --name "$container_name" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:17-alpine@sha256:3540c0362c809df084ffac0ae69fe794515f9de92692f02178bcdce0ef0302ac >/dev/null
for attempt in $(seq 1 40); do
 if docker exec "$container_name" pg_isready -U postgres >/dev/null 2>&1; then break; fi
 sleep 0.5
done
docker exec "$container_name" pg_isready -U postgres >/dev/null
for sql in supabase/tests/bootstrap.sql supabase/migrations/*.sql supabase/tests/security.sql; do
 docker exec -i "$container_name" psql -U postgres -v ON_ERROR_STOP=1 < "$sql"
done

bash supabase/tests/concurrency.sh "$container_name"
