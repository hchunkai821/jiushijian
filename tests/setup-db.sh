#!/usr/bin/env bash
# 啟動測試用的 Supabase Postgres 與 PostgREST，並依序執行所有 migration。
# 本機與 GitHub Actions 共用：bash tests/setup-db.sh；結束後 bash tests/setup-db.sh down
set -euo pipefail
cd "$(dirname "$0")/.."

PG_IMAGE=supabase/postgres:17.12.0.002
PGRST_IMAGE=postgrest/postgrest:v16.6
NET=jsj-test
PG=jsj-test-pg
REST=jsj-test-rest
ENV_FILE=tests/.test-env

down() { docker rm -f "$REST" "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -f "$ENV_FILE"; }
if [[ "${1:-}" == "down" ]]; then down; exit 0; fi
down

psql_as() { local user=$1; shift; docker exec -i "$PG" psql -U "$user" -h localhost -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

docker network create "$NET" >/dev/null
PG_PASSWORD=$(openssl rand -hex 16)
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD="$PG_PASSWORD" "$PG_IMAGE" >/dev/null

echo "等待資料庫啟動…"
for _ in $(seq 1 100); do
  if docker exec "$PG" psql -U postgres -h localhost -d postgres -tAc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "$PG" psql -U postgres -h localhost -d postgres -tAc 'select 1' >/dev/null

# Supabase 正式環境有 realtime.send；測試環境用一個會記錄呼叫的替身
psql_as supabase_admin <<'SQL'
create schema if not exists realtime;
create table if not exists realtime.sent (topic text, event text, private boolean, at timestamptz default now());
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql security definer as $$ insert into realtime.sent (topic, event, private) values (topic, event, private) $$;
grant usage on schema realtime to postgres;
grant select on realtime.sent to postgres;
grant execute on function realtime.send(jsonb, text, text, boolean) to postgres;
do $$ begin create publication supabase_realtime; exception when duplicate_object then null; end $$;
SQL

for f in supabase/schema.sql supabase/migrations/0*.sql; do
  echo "執行 $f"
  psql_as postgres < "$f" >/dev/null
done
echo "再執行一次 005（確認可以重複執行）"
psql_as postgres < supabase/migrations/005_security_hardening.sql >/dev/null

AUTH_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
psql_as supabase_admin -c "alter role authenticator with login password '$AUTH_PASSWORD';"
docker run -d --name "$REST" --network "$NET" -p 127.0.0.1:54330:3000 \
  -e PGRST_DB_URI="postgres://authenticator:$AUTH_PASSWORD@$PG:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon -e PGRST_JWT_SECRET="$JWT_SECRET" \
  "$PGRST_IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -sf -X POST http://127.0.0.1:54330/rpc/get_event -H 'content-type: application/json' -d '{"p_event":"zzzzzzzz"}' >/dev/null; then break; fi
  sleep 1
done

umask 077
printf 'JIU_TEST_REST=http://127.0.0.1:54330\nJIU_TEST_JWT_SECRET=%s\nJIU_TEST_PG_CONTAINER=%s\n' "$JWT_SECRET" "$PG" > "$ENV_FILE"
echo "測試環境就緒"
