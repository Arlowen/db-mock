#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root_dir"

sha256sum -c SHA256SUMS
docker load -i images/dbmock.tar
docker load -i images/postgres.tar
if [ ! -f .env ]; then
  cp .env.example .env
  password=$(openssl rand -base64 32 2>/dev/null || head -c 32 /dev/urandom | base64)
  escaped=$(printf '%s' "$password" | sed 's/[&|]/\\&/g')
  sed -i.bak "s|change-this-random-password|$escaped|" .env
  rm -f .env.bak
fi
docker compose --pull never up -d
docker compose ps
