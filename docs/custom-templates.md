# Custom template package

A custom database template is a ZIP archive with this minimum layout:

```text
dbmock-template.yaml
docker-compose.yml
config/                 # optional
scripts/                # optional
```

`dbmock-template.yaml` example:

```yaml
apiVersion: dbmock.io/v1alpha1
kind: DatabaseTemplate
metadata:
  slug: example-db
  name: Example DB
  nameZh: 示例数据库
  description: A trusted internal database template
  category: relational
  icon: EX
spec:
  version: "1.0.0"
  image: registry.example.com/example/db:1.0.0
  architectures: [amd64, arm64]
  composeFile: docker-compose.yml
  defaultPort: 5432
  minCpu: 1
  minMemoryBytes: 1073741824
  minDiskBytes: 10737418240
  username: dbmock
  database: app
  scheme: postgresql
  jdbcScheme: postgresql
  hostTuning: []
  upgradeScript: scripts/upgrade.sh # optional, runs after the upgraded Compose stack starts
```

The Compose file may use these Go template variables:

| Variable | Meaning |
|---|---|
| `{{ .InstanceID }}` | immutable instance UUID |
| `{{ .ShortID }}` | short ID suitable for container names |
| `{{ .Image }}` | image declared by the template version |
| `{{ .BindAddress }}` | host bind address |
| `{{ .HostPort }}` | allocated host port |
| `{{ .DataPath }}` | managed instance data directory |
| `{{ .CPU }}` | selected CPU limit |
| `{{ .MemoryBytes }}` | selected memory limit |
| `{{ .RestartPolicy }}` | generated restart policy |
| `{{ .ExtraEnvironment }}` | YAML fragment for user environment overrides |

Every long-running service that should follow the instance automatic-restart switch must set
`restart: "{{ .RestartPolicy }}"`. DB Mock renders `unless-stopped` when enabled and `no` when disabled;
the same value is restored if a runtime-configuration task fails.

The generated project `.env` provides `DB_USERNAME`, `DB_PASSWORD`, and `DB_NAME` for Compose
interpolation only. Compose does not automatically copy those values into a container. A custom
health check that needs credentials must explicitly map them to template-owned container variables,
then escape the runtime reference with `$$`:

```yaml
services:
  database:
    environment:
      TEMPLATE_DB_PASSWORD: "${DB_PASSWORD}"
    healthcheck:
      test: ["CMD-SHELL", "database-cli --password \"$${TEMPLATE_DB_PASSWORD}\" ping"]
```

`DBMOCK_DB_USERNAME`, `DBMOCK_DB_PASSWORD`, and `DBMOCK_DB_NAME` are reserved for built-in template
health checks and cannot be supplied through instance environment overrides.

`metadata.name`, `metadata.category`, `spec.version`, `spec.image`, positive minimum resources, and a
valid `spec.defaultPort` are required. `spec.architectures` accepts `amd64` and `arm64`; when omitted it
defaults to `amd64`. Packages are limited to 60 MiB compressed, 50 MiB expanded, 256 files, and 10 MiB
per expanded file.

DB Mock treats every custom template and script as trusted host-level code. Uploading a package produces
a risk report but does not block privileged settings.

Persistent files must be bind-mounted below `{{ .DataPath }}` to be included in instance backup,
restore, deletion, and upgrade rollback. The image named by `spec.image` must provide `/bin/sh` and
`tar`: DB Mock reuses that already-present image as a network-isolated, read-only helper container so
it can safely read and restore files owned by the database container. The helper never pulls an image;
this keeps the same behavior on online and offline hosts.

## Version lifecycle

Template versions are append-only. A later package may reuse an existing custom `metadata.slug` only
when `spec.version` is new. Uploading the same slug and version again is rejected; update the version
before changing Compose, scripts, images, resource requirements, or connection metadata. This keeps
existing instances pinned to the exact deployment contract they were created with.

Built-in slugs such as `mysql`, `postgresql`, and `redis` are reserved and cannot be replaced by a
custom package. The catalog details dialog lists every installed version and lets the user choose the
version used for a new instance. A custom template can be deleted only when no current or deleted
instance record refers to any of its versions; deletion also removes its stored ZIP packages from the
control service. Retaining this reference keeps historical instance records tied to their exact
deployment contract.
