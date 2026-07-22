# DB Mock deployment

## Prerequisites

- Control plane: Linux x86_64/arm64, or macOS with Docker Desktop.
- Docker Engine 24+ and Docker Compose v2; at least 2 CPUs, 4 GiB RAM, and 20 GiB free disk.
- The default listener is `0.0.0.0:8080`. The browser and control-plane container must be able to reach managed hosts over SSH.
- Managed Linux hosts require direct SSH. Installing or upgrading Docker through DB Mock requires passwordless `sudo` for the SSH user.
- The managed host's SSH user must be able to create the configured data root and read and write files inside it.
- Managed hosts must provide at least one of `ss`, `lsof`, or `netstat` so DB Mock can validate the port pool and avoid active listeners.
- Configure the Linux Docker daemon proxy from the host action menu. Configure macOS proxy settings in Docker Desktop first.

## Online installation

Run these commands from the source repository root:

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env and replace DBMOCK_POSTGRES_PASSWORD and the public URL.
make up
```

Alternatively, run `./scripts/install.sh` to generate a PostgreSQL password and start the stack. The
script first pulls `ghcr.io/arlowen/db-mock:latest` and falls back to building the application image
from the current checkout when no published image is available. Open `DBMOCK_PUBLIC_URL` and create
the first platform account.

`DBMOCK_TIMEZONE` is the first-run IANA timezone default. After creating the first account, change the
timezone in System settings; the runtime setting immediately controls audit, task, alert, and monitoring
timestamps without a service restart.

The application container serves both the API and embedded Web UI. The stack contains DB Mock and
PostgreSQL only; no Nginx or separate frontend service is required.

## Offline installation

Each GitHub Release contains `amd64` and `arm64` offline bundles plus a top-level `SHA256SUMS` file.
You can also build either bundle on an internet-connected machine with Docker:

```bash
./scripts/package-offline.sh v0.1.0 amd64
./scripts/package-offline.sh v0.1.0 arm64
```

Copy and extract `dist/dbmock-v0.1.0-linux-amd64-offline.tar.gz` on the offline control plane:

```bash
tar -xzf dbmock-v0.1.0-linux-amd64-offline.tar.gz
cd dbmock-offline
./offline-install.sh
```

The offline bundle is a standalone flattened directory. Its `compose.yaml`,
`.env.example`, and install script live at the extracted bundle root and do not
use the source repository's `deploy/` paths.

The bundle contains only the control-plane and PostgreSQL images. Upload database images from
`docker save` as `.tar`, `.tar.gz`, or `.tgz` in the Images & registries page.
Installation and offline upgrades verify the bundled image checksums before starting Compose with
`--pull never --no-build`, so the offline host never contacts a registry or tries to build from missing source.

## HTTPS

The Go service provides HTTP by default. Put a certificate and private key under `deploy/tls/` and
configure their container paths in `deploy/.env`:

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

Run `make up` again. The certificate and key must be configured together.

## Upgrade and operations

```bash
./scripts/upgrade.sh
make logs
curl -fsS http://127.0.0.1:8080/api/v1/health
```

The upgrade script creates a control-plane backup under `backups/` before it pulls and starts the new
version. Only set `DBMOCK_SKIP_PRE_UPGRADE_BACKUP=true` when a separately verified recovery copy exists.

After signing in, use Settings to change the monitoring interval, metric retention, disk thresholds,
and individual alert-type switches. Changes take effect on the next monitoring cycle without a
restart. A password or private key rejected by the target host raises a dedicated alert that resolves
after the credential is updated and the next probe succeeds.

Settings also controls the runtime file limit and browser chunk size for offline image uploads. New
upload sessions use the policy immediately. `DBMOCK_MAX_UPLOAD_BYTES` remains the deployment hard
ceiling, and an upload already in progress may finish with the file size accepted when it started.

The Images page can scan offline archives unused for 7 to 365 days, preview the candidates and
recoverable space, and clean a selected set manually. Only controller-side files with no active
instance reference and no actual distribution during the selected period are eligible. DB Mock never
automatically removes images that Docker has already loaded on target hosts.

### Control-plane backup and restore

PostgreSQL metadata, the credential master key, and uploaded artifacts live in named Compose volumes.
Create a consistent backup with:

```bash
make backup
# Or choose the destination explicitly.
./scripts/backup-platform.sh /secure/path/dbmock-control-plane.tar.gz
```

The application briefly stops to freeze writes. If the stack was already stopped, the script starts only
PostgreSQL temporarily and returns it to the stopped state afterward. The `0600` archive contains the master
key that can decrypt every stored credential, so copy it immediately to restricted off-host storage. For
production, encrypt it with a separate passphrase file and store that file independently:

```bash
openssl rand -base64 32 > /secure/path/dbmock-backup.pass
chmod 600 /secure/path/dbmock-backup.pass
DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  ./scripts/backup-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc
```

Validate an archive without changing the stack, then restore it explicitly:

```bash
DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  DBMOCK_RESTORE_VALIDATE_ONLY=true \
  ./scripts/restore-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc

DBMOCK_PLATFORM_BACKUP_PASSPHRASE_FILE=/secure/path/dbmock-backup.pass \
  DBMOCK_RESTORE_CONFIRM=RESTORE \
  ./scripts/restore-platform.sh /secure/path/dbmock-control-plane.tar.gz.enc
```

Restore completely replaces the current PostgreSQL database and application data volume. Before overwriting
them, the script creates a `dbmock-control-plane-pre-restore-*` safety backup. It starts the current application
and waits for health; any restore or health failure triggers an automatic rollback. The safety backup remains
after success until you archive or remove it according to your retention policy. In an extracted offline
bundle, the scripts live at its root; use `./backup-platform.sh` and
`./restore-platform.sh` with the same arguments and environment variables.
Control-plane archives do not include `deploy/.env`, TLS certificates, or TLS private keys, so preserve those
deployment files separately.
Never manually remove `dbmock_postgres_data` or `dbmock_dbmock_data`; losing the master key makes stored SSH,
registry, and database credentials unreadable.

DB Mock never modifies host firewalls or cloud security groups. Operators must expose the selected
instance ports according to their network policy.
