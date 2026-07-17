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

DB Mock treats every custom template and script as trusted host-level code. Uploading a package produces
a risk report but does not block privileged settings.
