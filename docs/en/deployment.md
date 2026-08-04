# DB Mock MVP deployment

This document covers the supported online Docker Compose installation, HTTPS, upgrade, and core
troubleshooting. Offline bundles, private/offline database images, and a settings center are outside the MVP.

## 1. Prerequisites

Control plane:

- Linux `amd64`/`arm64`, or macOS with Docker Desktop.
- Docker Engine 24+ and Docker Compose v2.
- At least 2 CPUs, 4 GiB RAM, and 20 GiB free disk.
- Internet access to the DB Mock, PostgreSQL, and selected public database images.
- Network access from the browser to DB Mock and from the DB Mock container to target-host SSH.

Target database host:

- Directly reachable Linux or macOS SSH host, without a jump server.
- Docker Engine and Docker Compose v2 already installed and available to the SSH user.
- A dedicated writable data root, `/opt/dbmock` by default.
- At least one of `ss`, `lsof`, or `netstat` for port-pool verification.
- A reserved test-database port range and organization-approved firewall rules.

DB Mock does not install Docker or modify firewalls/security groups.

## 2. Online installation

From the repository root:

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env: replace DBMOCK_POSTGRES_PASSWORD and verify DBMOCK_PUBLIC_URL.
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

Alternatively, use `./scripts/install.sh`. It generates a PostgreSQL password when `deploy/.env` is
missing, pulls published images, and falls back to building the application from the current checkout.

Verify the default HTTP deployment:

```bash
curl -fsS http://127.0.0.1:8080/api/v1/health
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 dbmock
```

Open `DBMOCK_PUBLIC_URL` and create the first administrator. `DBMOCK_TIMEZONE` is persisted during first
initialization; verify it before creating that account because the MVP has no settings page.

## 3. MVP configuration

Never commit `deploy/.env`.

| Variable | Purpose | Default/requirement |
| --- | --- | --- |
| `DBMOCK_POSTGRES_PASSWORD` | Metadata PostgreSQL password | Replace with a strong random value |
| `DBMOCK_IMAGE` | DB Mock image | `ghcr.io/arlowen/db-mock:latest` |
| `POSTGRES_IMAGE` | Metadata database image | `postgres:17-alpine` |
| `DBMOCK_PUBLIC_URL` | Exact browser-facing HTTP/HTTPS origin | No path, query, or fragment |
| `DBMOCK_BIND_ADDRESS` | Published bind address | `0.0.0.0`; narrow behind a proxy |
| `DBMOCK_PORT` | Published port | `8080` |
| `DBMOCK_TIMEZONE` | First-run IANA timezone | `Asia/Shanghai` |
| `DBMOCK_SESSION_DURATION` | Go-duration session lifetime | `720h` |
| `DBMOCK_TASK_WORKERS` | Persistent task concurrency | `4`, valid range `1–32` |
| `DBMOCK_TRUSTED_PROXIES` | Direct proxies allowed to set `X-Forwarded-For` | Empty |

Invalid duration, concurrency, public URL, TLS key pair, or trusted-proxy ranges prevent startup and name
the offending variable.

## 4. HTTPS

For built-in TLS, put the certificate and private key under `deploy/tls/` and use container paths:

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

The files must be configured together, match, and be readable by container UID/GID `100:101`.

A reverse proxy may terminate TLS instead. Leave the built-in certificate variables empty, set
`DBMOCK_PUBLIC_URL` to the public `https://` origin, and narrow `DBMOCK_BIND_ADDRESS` to loopback or the proxy
network. HTTPS public URLs still enable Secure cookies and HSTS.

DB Mock ignores forwarded client addresses unless the direct proxy is explicitly trusted:

```dotenv
DBMOCK_TRUSTED_PROXIES=10.0.0.10,10.0.1.0/24
```

Never configure `0.0.0.0/0`, `::/0`, or a network broader than the actual proxies. The edge proxy must
overwrite client-supplied `X-Forwarded-For`.

## 5. Persistence and upgrade

Named volumes:

- `dbmock_postgres_data`: accounts, hosts, databases, tasks, and metadata.
- `dbmock_dbmock_data`: credential master key and compatibility artifacts.

Regular `docker compose down` keeps these volumes. Do not delete the application-data volume: losing the
master key makes stored SSH and database credentials unreadable. Preserve `deploy/.env` and TLS files separately.

Upgrade with:

```bash
./scripts/upgrade.sh
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
make logs
```

The script creates a control-plane recovery archive under `backups/` before pulling new images. This is a
low-level upgrade safeguard, not an MVP management UI. Skip it only when a separately verified recovery copy
exists. Migrations support forward upgrades; do not assume that pointing `DBMOCK_IMAGE` at an older version is
a safe database downgrade.

## 6. Operations and troubleshooting

```bash
# Status and logs
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 postgres dbmock

# Stop while keeping volumes
make down

# Start again
make up
```

Do not run `docker compose down -v` without a verified backup and an explicit decision to erase the trial.

If DB Mock does not start, validate Compose, inspect PostgreSQL health, then read the first application ERROR.
Check the public URL, PostgreSQL password, port conflicts, and TLS file permissions before changing data volumes.

If a target host fails verification, test the same SSH account on that host:

```bash
docker version
docker compose version
test -w /opt/dbmock
command -v ss || command -v lsof || command -v netstat
```

Install or repair Docker through the organization's normal host process, then probe again in DB Mock.

For a failed database deployment, use the task stage, stable error, and redacted log. Verify public-image pull,
host capacity, port availability, SSH, and Docker. Probe the host after repair and retry only through the preserved
task/resource context. Do not click repeatedly when the request result is uncertain.

If connection details are correct but the client cannot connect, confirm the database is healthy, use the external
connection address and host port, and inspect firewall/security-group policy. DB Mock does not open the port.

If deletion is blocked, wait for active tasks or remove legacy managed backups through the same delete dialog. Never
bypass the server review by deleting only platform metadata.
