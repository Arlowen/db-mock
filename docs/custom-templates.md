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
  parameters: # optional, non-secret per-instance options
    - key: timezone
      type: select
      environment: TZ
      label: Time zone
      labelZh: 时区
      description: Container time zone
      descriptionZh: 容器时区
      required: true
      default: UTC
      options:
        - value: UTC
          label: UTC
        - value: Asia/Shanghai
          label: Shanghai
          labelZh: 上海
    - key: maxConnections
      type: number
      environment: MAX_CONNECTIONS
      label: Maximum connections
      required: false
      default: 100
      min: 10
      max: 1000
      step: 10
  resourceProfiles: # optional shortcuts shown in the creation wizard
    - name: development
      label: Development
      labelZh: 开发
      cpu: 1
      memoryBytes: 1073741824
      diskBytes: 10737418240
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
| `{{ .ExtraEnvironment }}` | YAML fragment for declared parameters and advanced environment overrides |

## Parameter forms and resource profiles

`spec.parameters` supports `text`, `number`, `boolean`, and `select`. Each parameter needs a stable
`key`, a container `environment` name, and an English `label`; Chinese labels and descriptions are
optional. Number parameters may declare `min`, `max`, and a positive `step`. Select parameters must
declare between 1 and 50 unique options. A template can declare at most 32 parameters.

Parameters are intentionally non-secret. Their selected values are visible in the instance configuration
and are stored independently from the encrypted database password. Do not use them for passwords, tokens,
or private keys; use the platform-managed database credential or another dedicated secret mechanism.
DB Mock validates submitted values against the immutable selected template version, quotes every rendered
environment value, and rejects collisions with advanced environment overrides.

The Compose source must put `{{ .ExtraEnvironment }}` directly inside a service `environment` mapping:

```yaml
services:
  database:
    image: "{{ .Image }}"
    environment:
      STATIC_SETTING: "enabled"
{{ .ExtraEnvironment }}
    restart: "{{ .RestartPolicy }}"
```

Package validation renders a unique value for every declared parameter and confirms that it appears under
a service environment block. Merely placing the placeholder elsewhere in the YAML is rejected. A parameter
is available inside the container by its declared `environment` name; when a shell command needs it, escape
the runtime expansion as `$$NAME` so Compose does not consume it first.

`spec.resourceProfiles` provides up to eight creation shortcuts. Every profile needs a unique `name`, CPU,
memory bytes, and disk bytes at or above the template minimum. Selecting a profile fills the resource form;
the user can still customize the resulting values. On template-version upgrade, retained parameter keys keep
their values, removed keys are dropped, and newly introduced defaults are applied. An upgrade is rejected
before it is queued when the target version introduces a required parameter without a default.

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
health checks and cannot be supplied by a declared parameter or an instance environment override.

The archive must not provide `.env`, an extra runtime `compose.yaml`, `data/`, `runtime/`, or any path
whose first component starts with `.dbmock-managed-files`; DB Mock owns those paths. The file declared by
`spec.composeFile` may itself be named `compose.yaml`, because it is rendered into the platform-owned
runtime file rather than copied as an additional project file. Put initialization assets under `config/`
or `scripts/` and let the container initialize `{{ .DataPath }}`. Package paths must be unique on
case-insensitive hosts, and a file cannot also be the parent of another package path. These checks keep
one package deployable on both Linux and macOS without overwriting credentials, database data, or internal
state.

`metadata.name`, `metadata.category`, `spec.version`, `spec.image`, positive minimum resources, and a
valid `spec.defaultPort` are required. `spec.architectures` accepts `amd64` and `arm64`; when omitted it
defaults to `amd64`. Packages are limited to 60 MiB compressed, 50 MiB expanded, 256 files, and 10 MiB
per expanded file.

Every Compose service must declare an `image`, and at least one service must use `spec.image` through
`{{ .Image }}` or the exact reference. DB Mock renders the Compose file during upload and stores the
complete, immutable image set. Direct pulls fetch every image explicitly; an offline archive must contain
every reference; configured registry credentials can be selected only when every reference uses that same
registry host.

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

Files other than the manifest and declared Compose source are version-owned project files. DB Mock keeps
a private manifest of those paths in each instance directory. During an upgrade it removes only files
owned by the previous package that are absent from the target package; database data and untracked runtime
files are never selected. Upgrade rollback performs the inverse reconciliation, so a failed target version
cannot leave new scripts or configuration active. Packages stored by older DB Mock releases that included
a reserved platform path remain readable, but that path is ignored and is never copied to the host.

Built-in slugs such as `mysql`, `postgresql`, and `redis` are reserved and cannot be replaced by a
custom package. The catalog details dialog lists every installed version and lets the user choose the
version used for a new instance. A custom template can be deleted only when no current or deleted
instance record refers to any of its versions; deletion also removes its stored ZIP packages from the
control service. Retaining this reference keeps historical instance records tied to their exact
deployment contract.
