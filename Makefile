.PHONY: test backend-test frontend-test frontend build docker compose-config up down logs backup restore offline clean

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

backup:
	./scripts/backup-platform.sh

restore:
	@test -n "$(BACKUP)" || (echo "Usage: make restore BACKUP=/path/to/dbmock-control-plane-backup.tar.gz" >&2; exit 1)
	DBMOCK_RESTORE_CONFIRM=RESTORE ./scripts/restore-platform.sh "$(BACKUP)"

offline:
	./scripts/package-offline.sh $(VERSION)

clean:
	rm -f db-mock
	rm -rf dist frontend/coverage frontend/test-results frontend/playwright-report
