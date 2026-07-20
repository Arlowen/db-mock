# CI Recovery and Repository Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore every GitHub Actions job and move backend and deployment assets into explicit top-level boundaries while preserving application behavior.

**Architecture:** Keep the project as a modular monolith and single repository. Move the complete Go module under `backend/`, keep React under `frontend/`, put all Compose/Docker/environment inputs under `deploy/`, and retain a root Makefile as the stable operator and developer interface. Fix CI by giving Compose E2E job-scoped configuration and upgrading only the vulnerable Go modules.

**Tech Stack:** Go 1.25, React 19, TypeScript 5.8, Vite 6, Vitest 3, Playwright, Docker Compose v2, GitHub Actions.

## Global Constraints

- Preserve application behavior and the single embedded frontend binary.
- Keep `README.md`, `LICENSE`, `Makefile`, and `AGENTS.md` at repository root.
- Store the committed environment template at `deploy/.env.example`; never commit `deploy/.env`.
- Do not suppress vulnerability findings.
- Do not create a pull request.
- Push the validated final commits directly to `origin/main`.

---

### Task 1: Add a Failing Repository-Layout Contract

**Files:**
- Create: `scripts/ci/verify-layout.sh`

**Interfaces:**
- Consumes: repository root resolved from the script location.
- Produces: zero only when the approved layout exists and legacy root paths are absent.

- [ ] **Step 1: Write the failing layout check**

```sh
#!/usr/bin/env sh
set -eu

root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root_dir"

for path in backend/cmd/dbmock/main.go backend/internal backend/web/embed.go backend/go.mod backend/go.sum deploy/docker/Dockerfile deploy/compose.yaml deploy/.env.example frontend/package.json README.md
do
  test -e "$path" || { echo "missing required repository path: $path" >&2; exit 1; }
done

for path in cmd internal web go.mod go.sum Dockerfile compose.yaml .env.example
do
  test ! -e "$path" || { echo "legacy root path still exists: $path" >&2; exit 1; }
done
```

- [ ] **Step 2: Run the check and verify RED**

Run: `chmod +x scripts/ci/verify-layout.sh && ./scripts/ci/verify-layout.sh`

Expected: exit 1 with `missing required repository path: backend/cmd/dbmock/main.go`.

---

### Task 2: Move Source and Deployment Assets Without Breaking Builds

**Files:**
- Move: `cmd/`, `internal/`, `web/`, `go.mod`, and `go.sum` under `backend/`
- Move: `Dockerfile`, `compose.yaml`, and `.env.example` under `deploy/`
- Modify: `frontend/vite.config.ts`
- Modify: `deploy/docker/Dockerfile`
- Modify: `deploy/compose.yaml`
- Modify: `Makefile`
- Modify: `.gitignore`
- Modify: `.dockerignore`

**Interfaces:**
- Consumes: frontend source and Go module path `github.com/pika/db-mock`.
- Produces: `backend/web/dist`, root `db-mock` binary, Docker image, and Compose stack configured by `deploy/.env`.

- [ ] **Step 1: Move the tracked paths mechanically**

```sh
mkdir -p backend deploy/docker
git mv cmd backend/cmd
git mv internal backend/internal
git mv web backend/web
git mv go.mod backend/go.mod
git mv go.sum backend/go.sum
git mv Dockerfile deploy/docker/Dockerfile
git mv compose.yaml deploy/compose.yaml
git mv .env.example deploy/.env.example
```

- [ ] **Step 2: Point Vite at the embedded backend assets**

Set `outDir: resolve(__dirname, '../backend/web/dist')` in `frontend/vite.config.ts`.

- [ ] **Step 3: Update the relocated Docker build stages**

```dockerfile
FROM ${NODE_IMAGE} AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
RUN npm run build

FROM ${GOLANG_IMAGE} AS backend
ARG VERSION=dev
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src/backend
RUN apk add --no-cache ca-certificates git
COPY backend/go.mod backend/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY backend/ ./
COPY --from=frontend /src/backend/web/dist ./web/dist
RUN --mount=type=cache,target=/root/.cache/go-build CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/dbmock ./cmd/dbmock
```

Keep the existing Alpine runtime stage unchanged.

- [ ] **Step 4: Correct Compose paths**

```yaml
build:
  context: ..
  dockerfile: deploy/docker/Dockerfile
  args:
    VERSION: ${DBMOCK_VERSION:-dev}
```

Set the TLS mount source to `${DBMOCK_TLS_DIR:-./tls}` and set
`DBMOCK_TLS_DIR=./tls` in `deploy/.env.example`.

- [ ] **Step 5: Replace the root Makefile interface**

```make
.PHONY: test backend-test frontend-test frontend build docker compose-config up down logs offline clean

VERSION ?= dev
COMPOSE_FILE ?= deploy/compose.yaml
ENV_FILE ?= deploy/.env
COMPOSE = docker compose --env-file $(ENV_FILE) -f $(COMPOSE_FILE)

test: backend-test frontend-test
backend-test:
	cd backend && go test ./...
frontend-test:
	cd frontend && npm ci && npm run typecheck && npm test
frontend:
	cd frontend && npm ci && npm run build
build: frontend
	cd backend && go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o ../db-mock ./cmd/dbmock
docker:
	docker build -f deploy/docker/Dockerfile --build-arg VERSION=$(VERSION) -t db-mock:$(VERSION) .
compose-config:
	$(COMPOSE) config --quiet
up:
	$(COMPOSE) up -d --build
down:
	$(COMPOSE) down
logs:
	$(COMPOSE) logs -f dbmock
offline:
	./scripts/package-offline.sh $(VERSION)
clean:
	rm -f db-mock
	rm -rf dist frontend/coverage frontend/test-results frontend/playwright-report
```

- [ ] **Step 6: Update ignores**

Replace root `.env` with `deploy/.env` in `.gitignore` and add `deploy/.env` to
`.dockerignore` while retaining dependency, report, and archive exclusions.

- [ ] **Step 7: Verify GREEN**

```sh
./scripts/ci/verify-layout.sh
cd backend && go test ./...
cd ../frontend && npm run typecheck && npm test && npm run build
cd .. && DBMOCK_POSTGRES_PASSWORD=ci-only-password DBMOCK_IMAGE=dbmock:e2e docker compose -f deploy/compose.yaml config --quiet
```

- [ ] **Step 8: Commit**

```sh
git add backend frontend deploy Makefile .gitignore .dockerignore scripts/ci/verify-layout.sh
git commit -m "refactor: clarify repository layout"
```

---

### Task 3: Repair CI, Release, and Operational Scripts

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `scripts/install.sh`, `scripts/upgrade.sh`, and `scripts/package-offline.sh`

**Interfaces:**
- Consumes: relocated backend and deployment inputs.
- Produces: four CI jobs plus working source-checkout and offline install flows.

- [ ] **Step 1: Verify the original cleanup trigger still reproduces**

Run: `env -u DBMOCK_POSTGRES_PASSWORD docker compose -f deploy/compose.yaml config --quiet`

Expected: exit 1 reporting the required password is missing.

- [ ] **Step 2: Split CI and provide Compose job environment**

Create `backend`, `frontend`, `compose-e2e`, and `vulnerability-scan` jobs. Use
`backend/go.mod` and `backend/go.sum` for Go setup/cache, `backend` as Go working
directory, separate frontend install/typecheck/test/build steps, and this E2E
job-level environment:

```yaml
env:
  DBMOCK_POSTGRES_PASSWORD: ci-only-password
  DBMOCK_IMAGE: dbmock:e2e
```

Use `docker compose -f deploy/compose.yaml` for startup, logs, and the
`if: always()` teardown. Configure govulncheck as:

```yaml
- uses: golang/govulncheck-action@v1
  with:
    go-version-file: backend/go.mod
    cache-dependency-path: backend/go.sum
    work-dir: backend
    go-package: ./...
```

- [ ] **Step 3: Update release Docker path**

Add `file: deploy/docker/Dockerfile` to `docker/build-push-action@v6`.

- [ ] **Step 4: Update online scripts**

Set `env_file="$root_dir/deploy/.env"` and
`compose_file="$root_dir/deploy/compose.yaml"` in `install.sh` and `upgrade.sh`.
Create the environment from `deploy/.env.example` and pass
`--env-file "$env_file" -f "$compose_file"` to every Compose command.

- [ ] **Step 5: Preserve the flattened offline bundle**

In `package-offline.sh`, copy `deploy/compose.yaml` and `deploy/.env.example`
into the bundle root as `compose.yaml` and `.env.example`. Rewrite the packaged
`DBMOCK_TLS_DIR` from `./tls` to `./deploy/tls`; leave offline install commands
root-relative inside the self-contained bundle.

- [ ] **Step 6: Verify paths and syntax**

```sh
sh -n scripts/install.sh scripts/upgrade.sh scripts/package-offline.sh scripts/offline-install.sh scripts/offline-upgrade.sh scripts/ci/verify-layout.sh
DBMOCK_POSTGRES_PASSWORD=ci-only-password DBMOCK_IMAGE=dbmock:e2e docker compose -f deploy/compose.yaml config --quiet
rg -n 'root_dir/compose.yaml|root_dir/.env.example' scripts .github Makefile
```

Expected: syntax and Compose pass; the obsolete path scan has no matches.

- [ ] **Step 7: Commit**

```sh
git add .github scripts
git commit -m "fix: repair CI and deployment automation"
```

---

### Task 4: Upgrade Vulnerable Go Dependencies

**Files:**
- Modify: `backend/go.mod`
- Modify: `backend/go.sum`

**Interfaces:**
- Consumes: the existing backend and fixed versions reported by GitHub Actions.
- Produces: a dependency graph with no reachable known vulnerabilities.

- [ ] **Step 1: Reproduce RED locally**

Run: `cd backend && go run golang.org/x/vuln/cmd/govulncheck@latest ./...`

Expected: nonzero exit with reachable findings in `x/crypto@v0.38.0`,
`pgx/v5@v5.7.4`, and `chi/v5@v5.2.1`.

- [ ] **Step 2: Upgrade only the vulnerable modules**

```sh
cd backend
go get github.com/go-chi/chi/v5@v5.2.2 github.com/jackc/pgx/v5@v5.9.2 golang.org/x/crypto@v0.52.0
go mod tidy
```

- [ ] **Step 3: Verify GREEN**

```sh
cd backend
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

Expected: tests exit 0 and govulncheck reports no vulnerabilities affecting the code.

- [ ] **Step 4: Inspect and commit**

```sh
git diff -- backend/go.mod backend/go.sum
git add backend/go.mod backend/go.sum
git commit -m "fix: upgrade vulnerable Go dependencies"
```

---

### Task 5: Update Entry Points and Documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/requirements.md`
- Modify: `docs/zh/deployment.md`
- Modify: `docs/en/deployment.md`

**Interfaces:**
- Consumes: root Make targets and final paths.
- Produces: copyable installation, development, testing, TLS, upgrade, and log commands.

- [ ] **Step 1: Update README**

Document the target tree and replace quick start with:

```sh
cp deploy/.env.example deploy/.env
# Edit deploy/.env and replace the database password and public URL.
make up
```

Use this local development flow:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d postgres
cd frontend && npm ci && npm run build
cd ../backend && go run ./cmd/dbmock
```

Document `make test`, `make build`, and `make docker` as root entry points.

- [ ] **Step 2: Update architecture and requirements paths**

Document `backend/` as the Go module, `frontend/` as source,
`backend/web/dist` as embedded output, and `deploy/compose.yaml` as the stack.
Change the backend acceptance command to `cd backend && go test ./...`.

- [ ] **Step 3: Update both deployment guides symmetrically**

Use `deploy/.env.example`, `deploy/.env`, `make up`, `make logs`, and
`./scripts/upgrade.sh` for source checkouts. Keep the flattened offline bundle's
root `.env.example`, `.env`, and `compose.yaml` instructions explicitly labeled.

- [ ] **Step 4: Verify documentation paths**

Run:

```sh
rg -n 'cp \.env\.example \.env|go run \./cmd/dbmock|go test \./\.\.\.' README.md docs
```

Expected: no obsolete source-checkout command remains outside a labeled offline-bundle section.

- [ ] **Step 5: Commit**

```sh
git add README.md docs/architecture.md docs/requirements.md docs/zh/deployment.md docs/en/deployment.md
git commit -m "docs: align guides with repository layout"
```

---

### Task 6: Full Verification and Main Push

**Files:**
- Verify only; no planned source modifications.

**Interfaces:**
- Consumes: every prior task.
- Produces: fresh local evidence, pushed `origin/main`, and a successful GitHub Actions run.

- [ ] **Step 1: Verify layout, formatting, and patch hygiene**

```sh
./scripts/ci/verify-layout.sh
test -z "$(gofmt -l backend/cmd backend/internal backend/web)"
git diff --check
```

- [ ] **Step 2: Verify backend**

```sh
cd backend
go test -race ./...
go run golang.org/x/vuln/cmd/govulncheck@latest ./...
```

- [ ] **Step 3: Verify frontend**

```sh
cd frontend
npm ci
npm run typecheck
npm test
npm run build
```

- [ ] **Step 4: Verify deployment configuration and image**

First run `env -u DBMOCK_POSTGRES_PASSWORD docker compose -f deploy/compose.yaml config --quiet` and expect the required-password failure. Then run:

```sh
DBMOCK_POSTGRES_PASSWORD=ci-only-password DBMOCK_IMAGE=dbmock:e2e docker compose -f deploy/compose.yaml config --quiet
docker build -f deploy/docker/Dockerfile --build-arg VERSION=verification -t db-mock:verification .
```

- [ ] **Step 5: Verify complete Compose E2E**

```sh
DBMOCK_POSTGRES_PASSWORD=ci-only-password DBMOCK_IMAGE=dbmock:e2e docker compose -f deploy/compose.yaml up --build -d
curl -fsS --retry 60 --retry-delay 2 --retry-all-errors http://127.0.0.1:8080/api/v1/health
cd frontend && npm run test:e2e
cd .. && DBMOCK_POSTGRES_PASSWORD=ci-only-password DBMOCK_IMAGE=dbmock:e2e docker compose -f deploy/compose.yaml down -v
```

- [ ] **Step 6: Audit scope**

```sh
git status --short
git diff --stat origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: no `.env`, reports, archives, dependency directories, or unrelated files are tracked.

- [ ] **Step 7: Push main and monitor CI**

```sh
git push origin main
gh run list --workflow ci.yml --branch main --limit 1
```

Wait for the run triggered by the pushed head commit. If a job fails, inspect its
logs, reproduce the new root cause, correct it, rerun all affected checks, commit,
push, and monitor again.
