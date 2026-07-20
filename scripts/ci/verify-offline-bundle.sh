#!/usr/bin/env sh
set -eu

archive=${1:-}
if [ ! -f "$archive" ]; then
  echo "offline bundle does not exist: $archive" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbmock-offline-verify.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT INT TERM
tar -xzf "$archive" -C "$work_dir"
bundle="$work_dir/dbmock-offline"

for path in \
  compose.yaml \
  .env.example \
  SHA256SUMS \
  images/dbmock.tar \
  images/postgres.tar \
  offline-install.sh \
  upgrade.sh \
  docs/deployment.md \
  docs/部署说明.md
do
  if [ ! -f "$bundle/$path" ]; then
    echo "offline bundle is missing required path: $path" >&2
    exit 1
  fi
done

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$bundle" && sha256sum -c SHA256SUMS)
elif command -v shasum >/dev/null 2>&1; then
  (cd "$bundle" && shasum -a 256 -c SHA256SUMS)
else
  echo "sha256sum or shasum is required to verify the offline bundle" >&2
  exit 1
fi
docker compose --env-file "$bundle/.env.example" -f "$bundle/compose.yaml" config --quiet
echo "verified offline bundle: $archive"
