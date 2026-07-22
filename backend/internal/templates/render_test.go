package templates

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"gopkg.in/yaml.v3"
)

func TestBuiltinsExposeHealthcheckCredentialsInsideContainers(t *testing.T) {
	type service struct {
		Environment map[string]string `yaml:"environment"`
		Healthcheck struct {
			Test []string `yaml:"test"`
		} `yaml:"healthcheck"`
	}
	type composeDocument struct {
		Services map[string]service `yaml:"services"`
	}

	instance := domain.Instance{
		ID:              uuid.New(),
		HostPort:        25432,
		BindAddress:     "0.0.0.0",
		CPU:             4,
		MemoryBytes:     8 * GiB,
		RemoteDirectory: "/opt/dbmock/instances/test",
	}
	for _, definition := range Builtins() {
		t.Run(definition.Slug, func(t *testing.T) {
			composeTemplate := definition.Compose
			if composeTemplate == "" {
				composeTemplate = singleServiceCompose(definition)
			}
			output, err := RenderCompose(
				domain.Template{Slug: definition.Slug},
				domain.TemplateVersion{ImageReference: definition.Image, ComposeTemplate: composeTemplate},
				instance,
				nil,
			)
			if err != nil {
				t.Fatal(err)
			}

			var document composeDocument
			if err := yaml.Unmarshal(output, &document); err != nil {
				t.Fatalf("rendered Compose is invalid YAML: %v\n%s", err, output)
			}
			if definition.Compose == "" {
				database, ok := document.Services["database"]
				if !ok {
					t.Fatalf("rendered Compose has no database service: %s", output)
				}
				wantEnvironment := map[string]string{
					"DBMOCK_DB_USERNAME": "${DB_USERNAME}",
					"DBMOCK_DB_PASSWORD": "${DB_PASSWORD}",
					"DBMOCK_DB_NAME":     "${DB_NAME}",
				}
				for key, want := range wantEnvironment {
					if got := database.Environment[key]; got != want {
						t.Errorf("environment %s = %q, want %q", key, got, want)
					}
				}
			}
			for name, service := range document.Services {
				if healthcheck := strings.Join(service.Healthcheck.Test, " "); strings.Contains(healthcheck, "$${DB_") {
					t.Errorf("service %s healthcheck still references a Compose-only DB_* variable: %s", name, healthcheck)
				}
			}
		})
	}
}

func TestBuiltinsRenderTheSelectedRestartPolicyForEveryService(t *testing.T) {
	type service struct {
		Restart string `yaml:"restart"`
	}
	type composeDocument struct {
		Services map[string]service `yaml:"services"`
	}
	for _, enabled := range []bool{false, true} {
		want := "no"
		if enabled {
			want = "unless-stopped"
		}
		for _, definition := range Builtins() {
			t.Run(fmt.Sprintf("%s/enabled=%t", definition.Slug, enabled), func(t *testing.T) {
				composeTemplate := definition.Compose
				if composeTemplate == "" {
					composeTemplate = singleServiceCompose(definition)
				}
				output, err := RenderCompose(domain.Template{Slug: definition.Slug}, domain.TemplateVersion{
					ImageReference: definition.Image, ComposeTemplate: composeTemplate,
				}, domain.Instance{ID: uuid.New(), HostPort: definition.Port, BindAddress: "127.0.0.1",
					CPU: definition.MinCPU, MemoryBytes: definition.MinMemory, AutoRestart: enabled,
					RemoteDirectory: "/opt/dbmock/instances/test"}, nil)
				if err != nil {
					t.Fatal(err)
				}
				var document composeDocument
				if err = yaml.Unmarshal(output, &document); err != nil {
					t.Fatalf("rendered Compose is invalid YAML: %v\n%s", err, output)
				}
				for name, rendered := range document.Services {
					if rendered.Restart != want {
						t.Errorf("service %s restart policy = %q, want %q", name, rendered.Restart, want)
					}
				}
			})
		}
	}
}

func TestRenderComposeRejectsReservedEnvironmentOverrides(t *testing.T) {
	instance := domain.Instance{
		ID:              uuid.New(),
		HostPort:        23306,
		BindAddress:     "0.0.0.0",
		CPU:             1,
		MemoryBytes:     1024,
		RemoteDirectory: "/opt/dbmock/instances/id",
	}
	version := domain.TemplateVersion{ImageReference: "image:1", ComposeTemplate: `services:
  db:
    image: "{{ .Image }}"
    environment:
{{ .ExtraEnvironment }}`}
	for _, key := range []string{"DBMOCK_DB_USERNAME", "DBMOCK_DB_PASSWORD", "DBMOCK_DB_NAME"} {
		t.Run(key, func(t *testing.T) {
			_, err := RenderCompose(domain.Template{Slug: "test"}, version, instance, map[string]string{key: "override"})
			if err == nil || !strings.Contains(err.Error(), "reserved") {
				t.Fatalf("expected reserved environment error, got %v", err)
			}
		})
	}
}

func TestRenderComposeEscapesEnvironment(t *testing.T) {
	instance := domain.Instance{ID: uuid.New(), HostPort: 23306, BindAddress: "0.0.0.0", CPU: 1, MemoryBytes: 1024,
		RemoteDirectory: "/opt/dbmock/instances/id"}
	tpl := domain.Template{Slug: "test"}
	version := domain.TemplateVersion{ImageReference: "image:1", ComposeTemplate: `services:
  db:
    image: "{{ .Image }}"
    environment:
{{ .ExtraEnvironment }}`}
	output, err := RenderCompose(tpl, version, instance, map[string]string{"SAFE": "value: with # chars"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), `SAFE: "value: with # chars"`) {
		t.Fatalf("unexpected output: %s", output)
	}
}

func TestConnection(t *testing.T) {
	manifest, _ := json.Marshal(Manifest{Scheme: "postgresql", JDBCScheme: "postgresql"})
	instance := domain.Instance{HostPort: 5432, DatabaseUsername: "user", DatabaseName: "db"}
	connection := Connection(domain.Template{}, domain.TemplateVersion{Manifest: manifest}, instance, "10.0.0.1", "p@ss")
	if !strings.Contains(connection.URI, "p%40ss") || connection.JDBC != "jdbc:postgresql://10.0.0.1:5432/db" {
		t.Fatalf("unexpected: %#v", connection)
	}
}
