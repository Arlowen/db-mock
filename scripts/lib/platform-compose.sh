#!/usr/bin/env sh

# Shared helpers for control-plane backup and restore scripts. The caller must
# set platform_compose_file and platform_env_file before sourcing this file.

platform_compose() {
  if [ -f "$platform_env_file" ]; then
    docker compose --env-file "$platform_env_file" -f "$platform_compose_file" "$@"
  else
    docker compose -f "$platform_compose_file" "$@"
  fi
}

platform_require_runtime() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker Engine or Docker Desktop is required." >&2
    return 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "Docker Compose v2 is required." >&2
    return 1
  fi
}

platform_service_running() {
  platform_compose ps --status running --services 2>/dev/null | grep -Fx "$1" >/dev/null 2>&1
}

platform_service_exists() {
  platform_compose ps -a --services 2>/dev/null | grep -Fx "$1" >/dev/null 2>&1
}

platform_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "sha256sum or shasum is required." >&2
    return 1
  fi
}

platform_wait_postgres() {
  attempt=1
  while [ "$attempt" -le 30 ]; do
    if platform_compose exec -T postgres sh -ec 'pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "PostgreSQL did not become ready within 60 seconds." >&2
  return 1
}

platform_wait_application() {
  attempts=${DBMOCK_RESTORE_HEALTH_ATTEMPTS:-60}
  case "$attempts" in
    ''|*[!0-9]*|0)
      echo "DBMOCK_RESTORE_HEALTH_ATTEMPTS must be a positive integer." >&2
      return 1
      ;;
  esac
  attempt=1
  while [ "$attempt" -le "$attempts" ]; do
    if platform_compose exec -T dbmock sh -ec '
      if [ -n "${DBMOCK_TLS_CERT_FILE:-}" ]; then
        wget --no-check-certificate -qO- https://127.0.0.1:8080/api/v1/health
      else
        wget -qO- http://127.0.0.1:8080/api/v1/health
      fi
    ' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "DB Mock did not become healthy after restore." >&2
  return 1
}
