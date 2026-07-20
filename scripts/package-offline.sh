#!/usr/bin/env sh
set -eu

version=${1:-dev}
architecture=${2:-amd64}
case "$version" in
  ''|*[!A-Za-z0-9._-]*)
    echo "version must contain only letters, numbers, dots, underscores, and dashes" >&2
    exit 1
    ;;
esac
case "$architecture" in
  amd64|arm64) ;;
  *)
    echo "architecture must be amd64 or arm64" >&2
    exit 1
    ;;
esac
app_image=${DBMOCK_IMAGE:-ghcr.io/arlowen/db-mock:$version}
postgres_image=${POSTGRES_IMAGE:-postgres:17-alpine}
root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$root_dir/dist"
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbmock-offline.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT INT TERM

mkdir -p "$output_dir" "$work_dir/dbmock-offline/images" "$work_dir/dbmock-offline/docs" "$work_dir/dbmock-offline/deploy/tls"
case "${DBMOCK_OFFLINE_SKIP_PULL:-false}" in
  false)
    docker pull --platform "linux/$architecture" "$app_image"
    docker pull --platform "linux/$architecture" "$postgres_image"
    ;;
  true) ;;
  *)
    echo "DBMOCK_OFFLINE_SKIP_PULL must be true or false" >&2
    exit 1
    ;;
esac
docker image inspect "$app_image" >/dev/null
docker image inspect "$postgres_image" >/dev/null
docker save "$app_image" -o "$work_dir/dbmock-offline/images/dbmock.tar"
docker save "$postgres_image" -o "$work_dir/dbmock-offline/images/postgres.tar"
cp "$root_dir/deploy/compose.yaml" "$work_dir/dbmock-offline/compose.yaml"
cp "$root_dir/deploy/.env.example" "$work_dir/dbmock-offline/.env.example"
cp "$root_dir/scripts/offline-install.sh" "$work_dir/dbmock-offline/"
cp "$root_dir/scripts/offline-upgrade.sh" "$work_dir/dbmock-offline/upgrade.sh"
cp "$root_dir/docs/zh/deployment.md" "$work_dir/dbmock-offline/docs/部署说明.md"
cp "$root_dir/docs/en/deployment.md" "$work_dir/dbmock-offline/docs/deployment.md"
awk -v app="$app_image" -v postgres="$postgres_image" '
  /^DBMOCK_IMAGE=/ { print "DBMOCK_IMAGE=" app; next }
  /^POSTGRES_IMAGE=/ { print "POSTGRES_IMAGE=" postgres; next }
  /^DBMOCK_TLS_DIR=/ { print "DBMOCK_TLS_DIR=./deploy/tls"; next }
  { print }
' "$work_dir/dbmock-offline/.env.example" > "$work_dir/dbmock-offline/.env.generated"
mv "$work_dir/dbmock-offline/.env.generated" "$work_dir/dbmock-offline/.env.example"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$work_dir/dbmock-offline" && sha256sum images/*.tar > SHA256SUMS)
else
  (cd "$work_dir/dbmock-offline" && shasum -a 256 images/*.tar > SHA256SUMS)
fi
tar -C "$work_dir" -czf "$output_dir/dbmock-$version-linux-$architecture-offline.tar.gz" dbmock-offline
echo "$output_dir/dbmock-$version-linux-$architecture-offline.tar.gz"
