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

archive=${1:-}
if [ ! -f "$archive" ]; then
  echo "Usage: $0 /path/to/dbmock-control-plane-backup.tar.gz" >&2
  exit 1
fi
archive_dir=$(CDPATH= cd -- "$(dirname -- "$archive")" && pwd)
archive="$archive_dir/$(basename -- "$archive")"
umask 077
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/dbmock-platform-restore.XXXXXX")
rollback_on_cleanup=false

manifest_value() {
  awk -F= -v wanted="$2" '$1 == wanted { sub(/^[^=]*=/, ""); print }' "$1/manifest"
}

extract_and_verify() {
  source_archive=$1
  destination=$2
  mkdir -p "$destination"
  entries=$(tar -tzf "$source_archive") || return 1
  for required in manifest database.dump app-data.tar; do
    if ! printf '%s\n' "$entries" | grep -Fx "$required" >/dev/null 2>&1; then
      echo "Backup is missing required entry: $required" >&2
      return 1
    fi
  done
  # Stream the three expected regular-file payloads instead of extracting the
  # archive directly. This prevents link entries from writing outside the
  # private restore workspace before checksums have been verified.
  tar -xOzf "$source_archive" manifest > "$destination/manifest" || return 1
  tar -xOzf "$source_archive" database.dump > "$destination/database.dump" || return 1
  tar -xOzf "$source_archive" app-data.tar > "$destination/app-data.tar" || return 1
  format=$(manifest_value "$destination" format)
  if [ "$format" != 1 ]; then
    echo "Unsupported control-plane backup format: ${format:-missing}" >&2
    return 1
  fi
  expected_database=$(manifest_value "$destination" database_sha256)
  expected_app_data=$(manifest_value "$destination" app_data_sha256)
  actual_database=$(platform_sha256 "$destination/database.dump") || return 1
  actual_app_data=$(platform_sha256 "$destination/app-data.tar") || return 1
  if [ "$expected_database" != "$actual_database" ]; then
    echo "Control-plane database dump checksum does not match the manifest." >&2
    return 1
  fi
  if [ "$expected_app_data" != "$actual_app_data" ]; then
    echo "Control-plane application data checksum does not match the manifest." >&2
    return 1
  fi
}

prepare_archive() {
  source_archive=$1
  decrypted_archive=$2
  magic=$(dd if="$source_archive" bs=8 count=1 2>/dev/null | od -An -tx1 | tr -d ' \n')
  if [ "$magic" != "53616c7465645f5f" ]; then
    printf '%s\n' "$source_archive"
    return 0
  fi
  if [ ! -s "${DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE:-}" ]; then
    echo "This control-plane backup is encrypted. Set DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE to its passphrase file." >&2
    return 1
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required to decrypt this control-plane backup." >&2
    return 1
  fi
  if ! openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "file:$DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE" \
    -in "$source_archive" -out "$decrypted_archive"; then
    echo "Unable to decrypt the control-plane backup; verify its passphrase file." >&2
    return 1
  fi
  printf '%s\n' "$decrypted_archive"
}

cleanup() {
  status=$1
  trap - 0 1 2 15
  if [ "$rollback_on_cleanup" = true ]; then
    echo "Restore was interrupted; attempting automatic rollback to the pre-restore state." >&2
    platform_compose stop dbmock >/dev/null 2>&1 || true
    if restore_components "$work_dir/safety" && start_and_check; then
      echo "The previous control-plane state was restored successfully." >&2
    else
      echo "Automatic rollback failed. Recover manually from: $safety_archive" >&2
    fi
  fi
  rm -rf "$work_dir"
  exit "$status"
}
trap 'cleanup $?' 0
trap 'cleanup 130' 1 2 15

requested_archive=$(prepare_archive "$archive" "$work_dir/requested.tar.gz")
extract_and_verify "$requested_archive" "$work_dir/requested"
if [ "${DBMOCK_RESTORE_VALIDATE_ONLY:-false}" = true ]; then
  echo "Control-plane backup is valid: $archive"
  exit 0
fi
case "${DBMOCK_RESTORE_VALIDATE_ONLY:-false}" in
  false) ;;
  *) echo "DBMOCK_RESTORE_VALIDATE_ONLY must be true or false." >&2; exit 1 ;;
esac
if [ "${DBMOCK_RESTORE_CONFIRM:-}" != RESTORE ]; then
  echo "Restore replaces all control-plane metadata and application data." >&2
  echo "Set DBMOCK_RESTORE_CONFIRM=RESTORE to confirm this destructive operation." >&2
  exit 1
fi

platform_require_runtime
if ! platform_service_exists postgres; then
  echo "The PostgreSQL service has not been created; install DB Mock before restore." >&2
  exit 1
fi
if ! platform_service_running postgres; then
  platform_compose start postgres >/dev/null
fi
platform_wait_postgres

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
safety_dir=${DBMOCK_PLATFORM_BACKUP_DIR:-$platform_root/backups}
safety_extension=tar.gz
if [ -n "${DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE:-}" ]; then
  safety_extension=tar.gz.enc
fi
safety_archive="$safety_dir/dbmock-control-plane-pre-restore-$timestamp-$$.$safety_extension"
"$script_dir/backup-platform.sh" "$safety_archive"
safety_archive_input=$(prepare_archive "$safety_archive" "$work_dir/safety.tar.gz")
extract_and_verify "$safety_archive_input" "$work_dir/safety"

restore_components() {
  source_dir=$1
  platform_compose exec -T postgres sh -ec '
    dropdb --maintenance-db=template1 -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB"
    createdb --maintenance-db=template1 -U "$POSTGRES_USER" -O "$POSTGRES_USER" "$POSTGRES_DB"
    exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error --no-owner --no-privileges
  ' < "$source_dir/database.dump" || return 1
  platform_compose run --rm --no-deps --pull never --entrypoint /bin/sh dbmock -ec '
    rm -rf /var/lib/dbmock/* /var/lib/dbmock/.[!.]* /var/lib/dbmock/..?*
    exec tar -C /var/lib/dbmock -xf -
  ' < "$source_dir/app-data.tar" || return 1
}

start_and_check() {
  platform_compose start dbmock >/dev/null || return 1
  platform_wait_application
}

platform_compose stop dbmock >/dev/null 2>&1 || true
rollback_on_cleanup=true
if restore_components "$work_dir/requested" && start_and_check; then
  rollback_on_cleanup=false
  trap - 0 1 2 15
  rm -rf "$work_dir"
  echo "Control-plane restore completed: $archive"
  echo "Pre-restore safety backup retained at: $safety_archive"
  exit 0
fi

echo "Requested restore failed; attempting automatic rollback to the pre-restore state." >&2
platform_compose stop dbmock >/dev/null 2>&1 || true
if restore_components "$work_dir/safety" && start_and_check; then
  rollback_on_cleanup=false
  trap - 0 1 2 15
  rm -rf "$work_dir"
  echo "Restore failed, and the previous control-plane state was restored successfully." >&2
  echo "Failed archive: $archive" >&2
  echo "Safety backup: $safety_archive" >&2
  exit 1
fi

rollback_on_cleanup=false
trap - 0 1 2 15
rm -rf "$work_dir"
echo "Restore and automatic rollback both failed. Keep the stack stopped and recover from: $safety_archive" >&2
exit 1
