#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$script_dir/../deploy/compose.yaml" ]; then
  platform_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
  platform_compose_file="$platform_root/deploy/compose.yaml"
  platform_env_file="$platform_root/deploy/.env"
elif [ -f "$script_dir/compose.yaml" ]; then
  platform_root=$script_dir
  platform_compose_file="$platform_root/compose.yaml"
  platform_env_file="$platform_root/.env"
else
  echo "Cannot find deploy/compose.yaml or compose.yaml next to this script." >&2
  exit 1
fi
. "$script_dir/lib/platform-compose.sh"

platform_require_runtime
umask 077
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir=${DBMOCK_PLATFORM_BACKUP_DIR:-$platform_root/backups}
backup_extension=tar.gz
if [ -n "${DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE:-}" ]; then
  backup_extension=tar.gz.enc
fi
output_file=${1:-$backup_dir/dbmock-control-plane-$timestamp.$backup_extension}
mkdir -p "$(dirname -- "$output_file")"
output_dir=$(CDPATH= cd -- "$(dirname -- "$output_file")" && pwd)
output_file="$output_dir/$(basename -- "$output_file")"
if [ -e "$output_file" ]; then
  echo "Backup already exists and will not be overwritten: $output_file" >&2
  exit 1
fi

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbmock-platform-backup.XXXXXX")
temporary_output="$output_dir/.$(basename -- "$output_file").tmp.$$"
restart_application=false
stop_postgres=false
cleanup() {
  status=$1
  trap - 0 1 2 15
  rm -rf "$work_dir" "$temporary_output"
  if [ "$restart_application" = true ]; then
    platform_compose start dbmock >/dev/null 2>&1 || true
  fi
  if [ "$stop_postgres" = true ]; then
    platform_compose stop postgres >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap 'cleanup $?' 0
trap 'cleanup 130' 1 2 15

if ! platform_service_exists postgres; then
  echo "The PostgreSQL service has not been created; install DB Mock before creating a backup." >&2
  exit 1
fi
if ! platform_service_running postgres; then
  platform_compose start postgres >/dev/null
  stop_postgres=true
fi
platform_wait_postgres

if platform_service_running dbmock; then
  platform_compose stop dbmock >/dev/null
  restart_application=true
fi

platform_compose exec -T postgres sh -ec \
  'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' \
  > "$work_dir/database.dump"

platform_compose run --rm --no-deps --pull never --entrypoint /bin/sh dbmock \
  -ec 'exec tar -C /var/lib/dbmock -cf - .' > "$work_dir/app-data.tar"

database_sha256=$(platform_sha256 "$work_dir/database.dump")
app_data_sha256=$(platform_sha256 "$work_dir/app-data.tar")
cat > "$work_dir/manifest" <<EOF
format=1
created_at=$timestamp
database_sha256=$database_sha256
app_data_sha256=$app_data_sha256
EOF

plain_archive="$work_dir/control-plane.tar.gz"
tar -C "$work_dir" -czf "$plain_archive" manifest database.dump app-data.tar
if [ -n "${DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE:-}" ]; then
  if [ ! -s "$DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE" ]; then
    echo "DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE must point to a non-empty readable file." >&2
    exit 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required for encrypted control-plane backups." >&2
    exit 1
  fi
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass "file:$DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE" \
    -in "$plain_archive" -out "$temporary_output"
else
  mv "$plain_archive" "$temporary_output"
fi
chmod 600 "$temporary_output"
mv "$temporary_output" "$output_file"

if [ "$restart_application" = true ]; then
  platform_compose start dbmock >/dev/null
  restart_application=false
fi
if [ "$stop_postgres" = true ]; then
  platform_compose stop postgres >/dev/null
  stop_postgres=false
fi
trap - 0 1 2 15
rm -rf "$work_dir"
echo "Control-plane backup created: $output_file"
if [ -n "${DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE:-}" ]; then
  echo "The archive is encrypted with AES-256-CBC and PBKDF2. Store its passphrase separately."
else
  echo "WARNING: this archive contains the credential master key and is not encrypted." >&2
  echo "Store it as a secret, or set DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE for encryption." >&2
fi
