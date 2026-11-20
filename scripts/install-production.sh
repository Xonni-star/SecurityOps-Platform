#!/usr/bin/env bash
set -euo pipefail

# Interactive installer for the SecurityOps production Compose stack.
# Secrets are read without echo and written only to the local env file.

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
env_file="$repo_root/.env.production"
compose_file="$repo_root/docker-compose.production.yml"

fail(){ echo "ERROR: $*" >&2; exit 1; }
need(){ command -v "$1" >/dev/null || fail "$1 is required"; }
need docker
need curl

docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"
[ -f "$compose_file" ] || fail "Missing $compose_file"

if [ -f "$env_file" ]; then
  echo "Existing configuration found: $env_file"
  read -r -p "Reuse and update it? [Y/n] " reuse
  case "$reuse" in
    [nN]*) fail "Installation cancelled; existing configuration was preserved" ;;
  esac
fi

read -r -p "Public frontend origin (for example https://securityops.example.com): " cors_origin
[ -n "$cors_origin" ] || fail "CORS_ORIGIN is required"
IFS=',' read -r -a origins <<< "$cors_origin"
for origin in "${origins[@]}"; do
  origin="$(printf '%s' "$origin" | xargs)"
  [[ "$origin" =~ ^https?://[^/]+$ ]] || fail "Invalid origin: $origin"
  case "$origin" in
    *'*'*|*localhost*|*127.0.0.1*|*::1*|*0.0.0.0*) fail "Production origin is unsafe: $origin" ;;
  esac
done

read -r -p "Published frontend port [8080]: " http_port
http_port=${http_port:-8080}
[[ "$http_port" =~ ^[0-9]+$ ]] && [ "$http_port" -ge 1 ] && [ "$http_port" -le 65535 ] || fail "Invalid frontend port"
read -r -p "Local API port [3000]: " api_port
api_port=${api_port:-3000}
[[ "$api_port" =~ ^[0-9]+$ ]] && [ "$api_port" -ge 1 ] && [ "$api_port" -le 65535 ] || fail "Invalid API port"

read -r -p "PostgreSQL user [securityops]: " postgres_user
postgres_user=${postgres_user:-securityops}
read -r -p "PostgreSQL database [securityops]: " postgres_db
postgres_db=${postgres_db:-securityops}
read -r -s -p "PostgreSQL password (leave blank to generate): " postgres_password
echo
if [ -z "$postgres_password" ]; then
  need openssl
  postgres_password="$(openssl rand -hex 32)"
  echo "A strong PostgreSQL password was generated and stored in $env_file."
fi
[ ${#postgres_password} -ge 16 ] || fail "PostgreSQL password must contain at least 16 characters"

read -r -p "SMTP host (optional): " smtp_host
read -r -p "SMS gateway URL (optional): " sms_gateway_url
read -r -s -p "TimeScan API token (leave blank if unused): " timescan_token
echo

umask 077
tmp_env="$env_file.tmp.$$"
trap 'rm -f "$tmp_env"' EXIT
cat >"$tmp_env" <<EOF
POSTGRES_USER=$postgres_user
POSTGRES_PASSWORD=$postgres_password
POSTGRES_DB=$postgres_db
CORS_ORIGIN=$cors_origin
HTTP_PORT=$http_port
API_PORT=$api_port
SMTP_HOST=$smtp_host
SMS_GATEWAY_URL=$sms_gateway_url
TIMESCAN_API_TOKEN=$timescan_token
EOF
mv "$tmp_env" "$env_file"

compose=(docker compose --env-file "$env_file" -f "$compose_file")
"${compose[@]}" config --quiet
echo "Building and starting SecurityOps Platform..."
"${compose[@]}" up -d --build

echo "Waiting for readiness..."
for _ in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:$http_port/ready" >/dev/null 2>&1; then
    echo
    echo "Installation completed successfully."
    echo "Frontend: $cors_origin"
    "${compose[@]}" ps
    exit 0
  fi
  sleep 2
done
"${compose[@]}" ps
"${compose[@]}" logs --no-color --tail=100 db backend frontend >&2
fail "The stack did not become ready within 120 seconds"
