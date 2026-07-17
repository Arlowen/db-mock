package templates

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

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
