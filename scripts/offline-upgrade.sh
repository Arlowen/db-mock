#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$root_dir"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 -c SHA256SUMS
else
  echo "sha256sum or shasum is required to verify the offline bundle" >&2
  exit 1
fi
for archive in images/*.tar; do docker load -i "$archive"; done
case "${DBMOCK_SKIP_PRE_UPGRADE_BACKUP:-false}" in
  false) "$root_dir/backup-platform.sh" ;;
  true) echo "WARNING: skipping the pre-upgrade control-plane backup." >&2 ;;
  *) echo "DBMOCK_SKIP_PRE_UPGRADE_BACKUP must be true or false." >&2; exit 1 ;;
esac
docker compose --pull never up -d --remove-orphans --no-build
docker compose ps
