# Built-in Template Healthcheck Runtime Design

## Goal

Make every built-in database template complete `docker compose up --wait` with health checks that read
the same credentials used to initialize the database container.

## Evidence and Failure Mode

DB Mock writes `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` to each instance project's `.env` file.
Docker Compose uses that file for interpolation, but does not automatically expose its entries inside a
container. Ten built-in `CMD-SHELL` health checks referenced those names at container runtime. As a
result, otherwise valid MySQL, PostgreSQL, Redis, Valkey, MongoDB, ClickHouse, Elasticsearch,
OpenSearch, SQL Server, openGauss, and OceanBase deployments could remain unhealthy until the
five-minute Compose wait timed out.

## Design

The single-service built-in Compose generator always adds three container environment variables:

- `DBMOCK_DB_USERNAME`, sourced from `${DB_USERNAME}`
- `DBMOCK_DB_PASSWORD`, sourced from `${DB_PASSWORD}`
- `DBMOCK_DB_NAME`, sourced from `${DB_NAME}`

Built-in shell health checks reference only the `DBMOCK_DB_*` runtime names and quote every credential
argument. MongoDB uses explicit username and password CLI flags instead of constructing a credentialed
URI. This avoids shell word splitting and URI parsing failures for generated or user-supplied values.

The three names form an internal contract. Instance `extraEnvironment` values using a reserved name are
rejected during Compose rendering, so a user override cannot make the health check observe different
credentials from the initialized database.

Custom template packages keep their existing contract. Their `.env` values remain available for
Compose interpolation, and package authors explicitly map any required value into a template-owned
container variable.

## Compatibility

The change affects newly rendered built-in instance projects. It does not change stored credentials,
connection strings, database-native environment names, public API payloads, or custom template Compose
files. Existing projects receive the corrected Compose definition when an operation rewrites their
project, such as a controlled upgrade; recreating an already failed instance also uses the corrected
catalog definition.

## Verification

The template contract test renders all 19 built-in templates and parses the result as YAML. It verifies
that every generated single-service template exposes all three runtime variables and that no built-in
health check still references a Compose-only `DB_*` name. A separate test proves instance environment
overrides cannot replace reserved names. Package tests and the full backend suite must pass before the
change is pushed.
