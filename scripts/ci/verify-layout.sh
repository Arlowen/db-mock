#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root_dir"

for path in \
  backend/cmd/dbmock/main.go \
  backend/internal \
  backend/web/embed.go \
  backend/go.mod \
  backend/go.sum \
  deploy/docker/Dockerfile \
  deploy/compose.yaml \
  deploy/.env.example \
  frontend/package.json \
  scripts/backup-platform.sh \
  scripts/restore-platform.sh \
  scripts/lib/platform-compose.sh \
  scripts/ci/verify-offline-bundle.sh \
  scripts/ci/verify-oci-platforms.py \
  .github/workflows/ci.yml \
  .github/workflows/release.yml \
  .dockerignore \
  .gitignore \
  README.md
do
  if [ ! -e "$path" ]; then
    echo "missing required repository path: $path" >&2
    exit 1
  fi
done

for path in cmd internal web go.mod go.sum Dockerfile compose.yaml .env.example
do
  if [ -e "$path" ]; then
    echo "legacy root path still exists: $path" >&2
    exit 1
  fi
done
