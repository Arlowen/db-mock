#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
env_file="$root_dir/deploy/.env"
compose_file="$root_dir/deploy/compose.yaml"

if [ ! -f "$env_file" ]; then
  echo "deploy/.env is missing; run ./scripts/install.sh first." >&2
  exit 1
fi

case "${DBMOCK_SKIP_PRE_UPGRADE_BACKUP:-false}" in
  false) "$root_dir/scripts/backup-platform.sh" ;;
  true) echo "WARNING: skipping the pre-upgrade control-plane backup." >&2 ;;
  *) echo "DBMOCK_SKIP_PRE_UPGRADE_BACKUP must be true or false." >&2; exit 1 ;;
esac
docker compose --env-file "$env_file" -f "$compose_file" pull
docker compose --env-file "$env_file" -f "$compose_file" up -d --remove-orphans
docker compose --env-file "$env_file" -f "$compose_file" ps
