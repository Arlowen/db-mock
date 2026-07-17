#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root_dir"
for archive in images/*.tar; do docker load -i "$archive"; done
docker compose --pull never up -d --remove-orphans
docker compose ps
