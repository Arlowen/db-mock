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
	return writeTemplatePackageWithEntries(t, manifest, map[string]string{
		"docker-compose.yml": `services:
  database:
    image: "{{ .Image }}"
    privileged: true
    labels:
      dbmock.instance: "{{ .InstanceID }}"
    healthcheck:
      test: ["CMD", "true"]
`,
	})
}

func writeTemplatePackageWithEntries(t *testing.T, manifest string, extra map[string]string) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "template.zip")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	entries := map[string]string{"dbmock-template.yaml": manifest}
	for name, content := range extra {
		entries[name] = content
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

func TestValidatePackageRejectsPlatformOwnedAndCaseCollidingPaths(t *testing.T) {
	compose := `services:
  database:
    image: "{{ .Image }}"
`
	for name, entries := range map[string]map[string]string{
		"generated environment": {
			"docker-compose.yml": compose,
			".env":               "DB_PASSWORD=overridden",
		},
		"case folded generated environment": {
			"docker-compose.yml": compose,
			".ENV":               "DB_PASSWORD=overridden",
		},
		"managed file manifest": {
			"docker-compose.yml":    compose,
			".dbmock-managed-files": "config/database.conf\n",
		},
		"managed database data": {
			"docker-compose.yml": compose,
			"data/database.bin":  "must not be package owned",
		},
		"managed runtime state": {
			"docker-compose.yml":   compose,
			"RUNTIME/database.pid": "must not be package owned",
		},
		"runtime compose shadow": {
			"docker-compose.yml": compose,
			"compose.yaml":       "services: {shadow: {}}\n",
		},
		"case colliding project files": {
			"docker-compose.yml":  compose,
			"config/database.cnf": "first",
			"CONFIG/DATABASE.CNF": "second",
		},
		"file and child path collision": {
			"docker-compose.yml":  compose,
			"config":              "file",
			"config/database.cnf": "child",
		},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := ValidatePackage(writeTemplatePackageWithEntries(t, validCustomManifest, entries))
			if err == nil {
				t.Fatal("expected unsafe project paths to be rejected")
			}
		})
	}
}

func TestPackageProjectFilesExcludesTheDeclaredComposeSource(t *testing.T) {
	manifest := strings.Replace(validCustomManifest, "composeFile: docker-compose.yml", "composeFile: stack/database.yml", 1)
	filename := writeTemplatePackageWithEntries(t, manifest, map[string]string{
		"stack/database.yml": `services:
  database:
    image: "{{ .Image }}"
`,
		"config/database.conf": "managed=true\n",
	})
	files, err := PackageProjectFiles(filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := files["stack/database.yml"]; exists {
		t.Fatalf("declared Compose source must not be copied into the runtime project: %#v", files)
	}
	if got := string(files["config/database.conf"]); got != "managed=true\n" {
		t.Fatalf("expected package configuration to remain deployable, got %q", got)
	}
}

func TestPackageProjectFilesIgnoresLegacyPlatformOwnedPathsInStoredArchives(t *testing.T) {
	filename := writeTemplatePackageWithEntries(t, validCustomManifest, map[string]string{
		"docker-compose.yml": `services:
  database:
    image: "{{ .Image }}"
`,
		".env":              "DB_PASSWORD=overridden",
		"data/database.bin": "must not be deployed",
	})
	files, err := PackageProjectFiles(filename)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := files[".env"]; exists {
		t.Fatal("legacy stored packages must not overwrite the generated project environment")
	}
	if _, exists := files["data/database.bin"]; exists {
		t.Fatal("legacy stored packages must not own managed database data")
	}
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
