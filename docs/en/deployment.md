# DB Mock deployment

## Prerequisites

- Control plane: Linux x86_64/arm64, or macOS with Docker Desktop.
- Docker Engine 24+ and Docker Compose v2; at least 2 CPUs, 4 GiB RAM, and 20 GiB free disk.
- The default listener is `0.0.0.0:8080`. The browser and control-plane container must be able to reach managed hosts over SSH.
- Managed Linux hosts require direct SSH. Installing or upgrading Docker through DB Mock requires passwordless `sudo` for the SSH user.
- Configure the Linux Docker daemon proxy from the host action menu. Configure macOS proxy settings in Docker Desktop first.

## Online installation

```bash
cp .env.example .env
# Edit .env and replace DBMOCK_POSTGRES_PASSWORD and the public URL.
docker compose pull
docker compose up -d
docker compose ps
```

Alternatively, run `./scripts/install.sh` to generate a PostgreSQL password and start the stack.
Open `DBMOCK_PUBLIC_URL` and create the first platform account.

The application container serves both the API and embedded Web UI. The stack contains DB Mock and
PostgreSQL only; no Nginx or separate frontend service is required.

## Offline installation

On an internet-connected machine with Docker, build an x86_64 bundle:

```bash
./scripts/package-offline.sh v0.1.0 amd64
```

Copy and extract `dist/dbmock-v0.1.0-linux-amd64-offline.tar.gz` on the offline control plane:

```bash
tar -xzf dbmock-v0.1.0-linux-amd64-offline.tar.gz
cd dbmock-offline
./offline-install.sh
```

The bundle contains only the control-plane and PostgreSQL images. Upload database images from
`docker save` as `.tar`, `.tar.gz`, or `.tgz` in the Images & registries page.

## HTTPS

The Go service provides HTTP by default. Put a certificate and private key under `deploy/tls/` and
configure their container paths in `.env`:

```dotenv
DBMOCK_PUBLIC_URL=https://dbmock.example.com:8080
DBMOCK_TLS_CERT_FILE=/etc/dbmock/tls/server.crt
DBMOCK_TLS_KEY_FILE=/etc/dbmock/tls/server.key
```

Run `docker compose up -d` again. The certificate and key must be configured together.

## Upgrade and operations

```bash
./scripts/upgrade.sh
docker compose logs -f dbmock
curl -fsS http://127.0.0.1:8080/api/v1/health
```

PostgreSQL data, the credential master key, and uploaded images live in named Compose volumes. DB Mock
does not provide built-in metadata backup. Do not manually delete `dbmock_postgres_data` or
`dbmock_dbmock_data`; losing the master key makes stored SSH, registry, and database credentials
unreadable.

DB Mock never modifies host firewalls or cloud security groups. Operators must expose the selected
instance ports according to their network policy.
