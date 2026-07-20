package templates

import (
	"archive/zip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const validCustomManifest = `apiVersion: dbmock.io/v1alpha1
kind: DatabaseTemplate
metadata:
  slug: internal-postgres
  name: Internal PostgreSQL
  category: relational
spec:
  version: "1.0.0"
  image: registry.example.test/postgres:1.0.0
  architectures: [AMD64, arm64, amd64]
  composeFile: docker-compose.yml
  defaultPort: 5432
  minCpu: 1
  minMemoryBytes: 1073741824
  minDiskBytes: 10737418240
  username: dbmock
  database: app
  scheme: postgresql
`

func writeTemplatePackage(t *testing.T, manifest string) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "template.zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	entries := map[string]string{
		"dbmock-template.yaml": manifest,
		"docker-compose.yml": `services:
  database:
    image: "{{ .Image }}"
    privileged: true
    labels:
      dbmock.instance: "{{ .InstanceID }}"
    healthcheck:
      test: ["CMD", "true"]
`,
	}
	for name, content := range entries {
		entry, createErr := archive.Create(name)
		if createErr != nil {
			t.Fatal(createErr)
		}
		if _, writeErr := entry.Write([]byte(content)); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	if err = archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestValidatePackageStoresImmutableVersionRiskReport(t *testing.T) {
	validated, err := ValidatePackage(writeTemplatePackage(t, validCustomManifest))
	if err != nil {
		t.Fatal(err)
	}
	if got := validated.Version.Architectures; len(got) != 2 || got[0] != "amd64" || got[1] != "arm64" {
		t.Fatalf("expected normalized unique architectures, got %v", got)
	}
	if !strings.Contains(string(validated.Template.RiskReport), `"privileged"`) || string(validated.Template.RiskReport) != string(validated.Version.RiskReport) {
		t.Fatalf("expected the risk report to be stored on the immutable version: template=%s version=%s", validated.Template.RiskReport, validated.Version.RiskReport)
	}
}

func TestValidatePackageRejectsMissingImageAndUnknownArchitecture(t *testing.T) {
	withoutImage := strings.Replace(validCustomManifest, "  image: registry.example.test/postgres:1.0.0\n", "", 1)
	if _, err := ValidatePackage(writeTemplatePackage(t, withoutImage)); err == nil || !strings.Contains(err.Error(), "image") {
		t.Fatalf("expected a missing image error, got %v", err)
	}
	unknownArchitecture := strings.Replace(validCustomManifest, "[AMD64, arm64, amd64]", "[riscv64]", 1)
	if _, err := ValidatePackage(writeTemplatePackage(t, unknownArchitecture)); err == nil || !strings.Contains(err.Error(), "architecture") {
		t.Fatalf("expected an architecture error, got %v", err)
	}
}
