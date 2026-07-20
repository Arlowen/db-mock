# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine
ARG GOLANG_IMAGE=golang:1.25-alpine
ARG ALPINE_IMAGE=alpine:3.22
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

FROM ${ALPINE_IMAGE}
RUN apk add --no-cache ca-certificates tzdata && addgroup -S dbmock && adduser -S -G dbmock -h /var/lib/dbmock dbmock
WORKDIR /var/lib/dbmock
COPY --from=backend /out/dbmock /usr/local/bin/dbmock
RUN mkdir -p /var/lib/dbmock/artifacts && chown -R dbmock:dbmock /var/lib/dbmock
USER dbmock
EXPOSE 8080
VOLUME ["/var/lib/dbmock"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/v1/health >/dev/null || exit 1
ENTRYPOINT ["/usr/local/bin/dbmock"]
