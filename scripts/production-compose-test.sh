#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose version >/dev/null || { echo "docker compose is required" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/securityops-production-compose.XXXXXX")"
project="securityops-production-test-$$"
if [ -n "${HTTP_PORT:-}" ] && [ -n "${API_PORT:-}" ]; then
  http_port="$HTTP_PORT"
  api_port="$API_PORT"
else
  read -r default_http_port default_api_port < <(node -e '
    const net = require("node:net");
    const servers = [net.createServer(), net.createServer()];
    Promise.all(servers.map(server => new Promise(resolve => {
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    }))).then(ports => {
      console.log(ports.join(" "));
      servers.forEach(server => server.close());
    });
  ')
  http_port="${HTTP_PORT:-$default_http_port}"
  api_port="${API_PORT:-$default_api_port}"
fi
compose=(docker compose -p "$project" --env-file "$work_dir/.env.production" -f "$work_dir/docker-compose.production.yml")
expected_migrations="$(find "$repo_root/backend/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"
expected_upgrade_migrations=$((expected_migrations + 1))

cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

cp "$repo_root/docker-compose.production.yml" "$work_dir/"
cp -R "$repo_root/backend" "$work_dir/"
cp -R "$repo_root/frontend" "$work_dir/"
duplicate_migrations="$(find "$work_dir/backend/migrations" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | awk -F_ '{print $1}' | sort | uniq -d)"
if [ -n "$duplicate_migrations" ]; then
  echo "Duplicate migration versions: $duplicate_migrations" >&2
  find "$work_dir/backend/migrations" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; | sort >&2
  exit 1
fi
if grep -q '/docker-entrypoint-initdb.d' "$work_dir/docker-compose.production.yml"; then
  echo "Production Compose must not let PostgreSQL execute backend migrations" >&2
  exit 1
fi
cat >"$work_dir/.env.production" <<EOF
POSTGRES_USER=securityops
POSTGRES_PASSWORD=compose-test-password
POSTGRES_DB=securityops
CORS_ORIGIN=https://pi5.example.test
HTTP_PORT=$http_port
API_PORT=$api_port
# Ephemeral CI/integration-test markers only; never use these values in production.
MFA_ENCRYPTION_KEY=ci-production-compose-test-only-not-a-secret
KEY_QR_SECRET=ci-production-compose-test-qr-secret-9f2c7a41e6b8d350
MINIO_ROOT_USER=ci-compose-test-minio
MINIO_ROOT_PASSWORD=ci-compose-test-minio-secret-9f2c7a41e6b8d350
EOF

baseline_migration_count="$(find "$work_dir/backend/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ')"

wait_for() {
  local url="$1"
  for _ in $(seq 1 90); do
    if curl --fail --silent --show-error "$url" >/dev/null; then return 0; fi
    sleep 2
  done
  "${compose[@]}" ps
  "${compose[@]}" logs --no-color db minio minio-init clamav backend frontend
  return 1
}

assert_health() {
  for _ in $(seq 1 45); do
    all_healthy=true
    for service in db minio clamav backend frontend; do
      container="$("${compose[@]}" ps -q "$service")"
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
      if [ "$status" != healthy ]; then all_healthy=false; fi
    done
    if [ "$all_healthy" = true ]; then return 0; fi
    sleep 2
  done
  for service in db minio clamav backend frontend; do
    container="$("${compose[@]}" ps -q "$service")"
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
    echo "$service health is $status" >&2
  done
  return 1
}

psql() {
  "${compose[@]}" exec -T db psql -U securityops -d securityops -v ON_ERROR_STOP=1 -Atqc "$1"
}

echo "Starting fresh production stack"
"${compose[@]}" up -d --build
wait_for "http://127.0.0.1:$api_port/ready"
wait_for "http://127.0.0.1:$http_port/ready"
wait_for "http://127.0.0.1:$api_port/ready/dms"
assert_health
test "$(psql "SELECT count(*) FROM securityops_migrations;")" = "$expected_migrations"
test "$(psql "SELECT count(*) FROM securityops_migrations WHERE baseline=false;")" = "$expected_migrations"
test "$(psql "SELECT count(*) FROM tenants;")" = 1

psql "INSERT INTO tenants(id,name) VALUES ('00000000-0000-0000-0000-0000000000f1','Compose persistence') ON CONFLICT DO NOTHING;"
test "$(psql "SELECT count(*) FROM tenants;")" = 2

cookie_jar="$work_dir/cookies.txt"
login_body="$work_dir/login.json"
curl --fail --silent --show-error \
  -H 'Origin: https://pi5.example.test' \
  -H 'Content-Type: application/json' \
  -c "$cookie_jar" \
  -d '{"email":"admin@example.com","password":"password","device_id":"00000000-0000-4000-8000-0000000000f2"}' \
  "http://127.0.0.1:$api_port/api/v1/auth/login" >"$login_body"
grep -q '"user"' "$login_body"
curl --fail --silent --show-error -b "$cookie_jar" \
  -H 'Origin: https://pi5.example.test' \
  "http://127.0.0.1:$api_port/api/v1/auth/me" | grep -q 'admin@example.com'
curl --fail --silent --show-error -b "$cookie_jar" \
  -H 'Origin: https://pi5.example.test' \
  "http://127.0.0.1:$http_port/api/v1/auth/me" | grep -q 'admin@example.com'

echo "Restarting without data loss"
"${compose[@]}" restart db backend frontend
wait_for "http://127.0.0.1:$api_port/ready"
wait_for "http://127.0.0.1:$http_port/ready"
assert_health
test "$(psql "SELECT count(*) FROM securityops_migrations;")" = "$expected_migrations"
test "$(psql "SELECT count(*) FROM tenants;")" = 2

upgrade_migration_file="$work_dir/backend/migrations/$(printf '%03d' "$((baseline_migration_count + 1))")_production_compose_upgrade.sql"
cat >"$upgrade_migration_file" <<'EOF'
CREATE TABLE IF NOT EXISTS production_compose_upgrade_marker (
  id integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO production_compose_upgrade_marker(id) VALUES (1) ON CONFLICT DO NOTHING;
EOF

echo "Applying an additive upgrade"
"${compose[@]}" up -d --build backend
wait_for "http://127.0.0.1:$api_port/ready"
wait_for "http://127.0.0.1:$http_port/ready"
assert_health
test "$(psql "SELECT count(*) FROM securityops_migrations;")" = "$expected_upgrade_migrations"
test "$(psql "SELECT count(*) FROM production_compose_upgrade_marker;")" = 1
test "$(psql "SELECT count(*) FROM tenants;")" = 2
echo "Production Compose integration test passed"
