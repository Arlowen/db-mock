#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root_dir/deploy/.env"
env_example="$root_dir/deploy/.env.example"
compose_file="$root_dir/deploy/compose.yaml"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine or Docker Desktop is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
if [ ! -f "$env_file" ]; then
  cp "$env_example" "$env_file"
  password=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
  escaped=$(printf '%s' "$password" | sed 's/[&|]/\\&/g')
  sed -i.bak "s|change-this-random-password|$escaped|" "$env_file"
  rm -f "$env_file.bak"
  echo "Created deploy/.env with a generated PostgreSQL password."
fi

if docker compose --env-file "$env_file" -f "$compose_file" pull; then
  echo "Downloaded published DB Mock images."
else
  echo "Published DB Mock image is unavailable; building the application image from this checkout." >&2
  docker compose --env-file "$env_file" -f "$compose_file" pull postgres
  docker compose --env-file "$env_file" -f "$compose_file" build dbmock
fi
docker compose --env-file "$env_file" -f "$compose_file" up -d --no-build
echo "DB Mock is starting. Open the DBMOCK_PUBLIC_URL configured in deploy/.env."
