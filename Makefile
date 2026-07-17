.PHONY: test build frontend docker offline clean

VERSION ?= dev

test:
	go test ./...
	cd frontend && npm ci && npm test

frontend:
	cd frontend && npm ci && npm run build

build: frontend
	go build -trimpath -ldflags="-s -w -X main.version=$(VERSION)" -o db-mock ./cmd/dbmock

docker:
	docker build --build-arg VERSION=$(VERSION) -t db-mock:$(VERSION) .

offline:
	./scripts/package-offline.sh $(VERSION)

clean:
	rm -f db-mock
	rm -rf dist frontend/coverage frontend/test-results frontend/playwright-report
