#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root_dir"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine or Docker Desktop is required." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 1
fi
if [ ! -f .env ]; then
  cp .env.example .env
  password=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
  escaped=$(printf '%s' "$password" | sed 's/[&|]/\\&/g')
  sed -i.bak "s|change-this-random-password|$escaped|" .env
  rm -f .env.bak
  echo "Created .env with a generated PostgreSQL password."
fi

docker compose pull
docker compose up -d
echo "DB Mock is starting. Open the DBMOCK_PUBLIC_URL configured in .env."
