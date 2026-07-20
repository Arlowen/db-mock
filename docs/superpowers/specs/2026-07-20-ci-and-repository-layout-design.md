# CI Recovery and Repository Layout Design

## Goal

Restore all GitHub Actions checks and reorganize the repository into explicit
backend, frontend, deployment, documentation, and automation boundaries without
changing product behavior.

## Current Evidence

The latest `main` workflow run (`29668715188`) has two independent failures:

- `compose-e2e` completes the browser smoke test, then fails in `docker compose
  down -v` because that step does not receive the required
  `DBMOCK_POSTGRES_PASSWORD` variable.
- `vulnerability-scan` reports seven reachable vulnerabilities in
  `golang.org/x/crypto@v0.38.0`, `github.com/jackc/pgx/v5@v5.7.4`, and
  `github.com/go-chi/chi/v5@v5.2.1`. The reported fixed versions are v0.52.0,
  v5.9.2, and v5.2.2 respectively.

The regular Go tests, frontend tests and build, formatting check, service health
check, and browser smoke test already pass in that workflow run.

## Target Layout

```text
db-mock/
├── .github/                 # GitHub Actions workflows
├── backend/                 # Complete Go module
│   ├── cmd/dbmock/          # Application entry point
│   ├── internal/            # Private backend packages and migrations
│   ├── web/                 # Embedded frontend build output
│   ├── go.mod
│   └── go.sum
├── frontend/                # React/Vite application and browser tests
├── deploy/                  # Deployment inputs
│   ├── docker/Dockerfile
│   ├── compose.yaml
│   ├── .env.example
│   └── tls/
├── docs/                    # Product, architecture, and deployment docs
├── scripts/                 # Install, upgrade, packaging, and CI helpers
├── AGENTS.md
├── LICENSE
├── Makefile                 # Stable repository-level developer interface
└── README.md                # Project entry point
```

The local deployment secret file is `deploy/.env`. It remains ignored by Git.
The committed `deploy/.env.example` contains placeholders only.

## Build and Runtime Design

The Docker build context remains the repository root so one image build can
access both applications. The Dockerfile moves to `deploy/docker/Dockerfile` and
copies frontend manifests from `frontend/`, backend module manifests from
`backend/`, and the Vite output into `backend/web/dist` before compiling
`./cmd/dbmock` from the backend module.

The Compose file moves to `deploy/compose.yaml`. Relative bind mounts are made
correct for its new directory. Repository-level Make targets pass the Compose
file and environment file explicitly, so callers do not depend on Docker
Compose's current-directory discovery rules.

Frontend Vite output changes from the old root `web/dist` path to
`backend/web/dist`. The generated distribution remains committed because Go's
`embed` package requires it at compile time and the existing release model
ships one self-contained binary.

## CI Design

CI is split into four independently diagnosable jobs:

- `backend`: race-enabled Go tests and Go formatting verification from
  `backend/`.
- `frontend`: deterministic dependency installation, type checking, unit tests,
  and production build from `frontend/`.
- `compose-e2e`: root-context image build, service health check, Playwright smoke
  test, log collection, and cleanup. Required Compose variables live at job
  scope so setup and `if: always()` cleanup see identical configuration.
- `vulnerability-scan`: `govulncheck` against `./...` from `backend/`.

All action cache paths and Go working directories are updated for the new
layout. Release and offline-package workflows use the relocated Dockerfile and
Compose assets.

## Dependency Remediation

Upgrade only the modules named by `govulncheck` to their first reported fixed
versions or a compatible newer patch selected by Go module resolution. Run
`go mod tidy`, inspect the resulting transitive changes, and reject unrelated
major-version upgrades.

No vulnerability is suppressed and the scan remains a required failing gate.

## Compatibility and Error Handling

- `make` remains the stable entry point for development, builds, tests, Docker,
  Compose, and offline packaging.
- README and deployment documentation show exact new paths and commands.
- Install and upgrade scripts resolve assets relative to their own location or
  the extracted bundle, not the caller's current directory.
- Compose continues to fail clearly when the PostgreSQL password is absent.
  Only CI supplies a CI-only value automatically.
- Cleanup remains `if: always()` and receives the same configuration as startup.

## Verification

The migration is accepted only when all of the following pass from a clean
checkout-equivalent state:

1. Repository-layout regression check.
2. `go test -race ./...` from `backend/`.
3. Go formatting check across `backend/cmd`, `backend/internal`, and
   `backend/web`.
4. Frontend `npm run typecheck`, `npm test`, and `npm run build`.
5. `govulncheck ./...` from `backend/`.
6. Compose interpolation both rejects a missing password and accepts the CI
   configuration.
7. Docker image build from the repository root with the relocated Dockerfile.
8. Compose health check and Playwright smoke test when the local Docker runtime
   supports them.
9. README and documentation path scan plus `git diff --check`.

The final commit is pushed directly to `origin/main`, as explicitly requested.

