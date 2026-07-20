package templates

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"

	"github.com/pika/db-mock/internal/store"
	"gopkg.in/yaml.v3"
)

type PackageManifest struct {
	APIVersion string `yaml:"apiVersion"`
	Kind       string `yaml:"kind"`
	Metadata   struct {
		Slug        string `yaml:"slug"`
		Name        string `yaml:"name"`
		NameZH      string `yaml:"nameZh"`
		Description string `yaml:"description"`
		Category    string `yaml:"category"`
		Icon        string `yaml:"icon"`
	} `yaml:"metadata"`
	Spec struct {
		Version       string   `yaml:"version"`
		Image         string   `yaml:"image"`
		Architectures []string `yaml:"architectures"`
		ComposeFile   string   `yaml:"composeFile"`
		DefaultPort   int      `yaml:"defaultPort"`
		MinCPU        float64  `yaml:"minCpu"`
		MinMemory     int64    `yaml:"minMemoryBytes"`
		MinDisk       int64    `yaml:"minDiskBytes"`
		Username      string   `yaml:"username"`
		Database      string   `yaml:"database"`
		Scheme        string   `yaml:"scheme"`
		JDBCScheme    string   `yaml:"jdbcScheme"`
		HostTuning    []string `yaml:"hostTuning"`
		UpgradeScript string   `yaml:"upgradeScript"`
	} `yaml:"spec"`
}

type ValidatedPackage struct {
	Template store.TemplateInput
	Version  store.TemplateVersionInput
	Files    map[string][]byte
}

func ValidatePackage(filename string) (ValidatedPackage, error) {
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return ValidatedPackage{}, fmt.Errorf("open template zip: %w", err)
	}
	defer reader.Close()
	if len(reader.File) > 256 {
		return ValidatedPackage{}, errors.New("template package contains too many files")
	}
	files := make(map[string][]byte)
	var total int64
	for _, item := range reader.File {
		name := path.Clean(strings.ReplaceAll(item.Name, "\\", "/"))
		if path.IsAbs(name) || strings.HasPrefix(name, "../") {
			return ValidatedPackage{}, fmt.Errorf("unsafe package path %q", item.Name)
		}
		if item.FileInfo().IsDir() {
			continue
		}
		if _, exists := files[name]; exists {
			return ValidatedPackage{}, fmt.Errorf("template package contains duplicate path %q", name)
		}
		if item.UncompressedSize64 > 10*1024*1024 {
			return ValidatedPackage{}, fmt.Errorf("template file %s exceeds 10 MiB", name)
		}
		handle, err := item.Open()
		if err != nil {
			return ValidatedPackage{}, err
		}
		content, readErr := io.ReadAll(io.LimitReader(handle, 10*1024*1024+1))
		_ = handle.Close()
		if readErr != nil {
			return ValidatedPackage{}, readErr
		}
		if len(content) > 10*1024*1024 {
			return ValidatedPackage{}, fmt.Errorf("template file %s exceeds 10 MiB", name)
		}
		total += int64(len(content))
		if total > 50*1024*1024 {
			return ValidatedPackage{}, errors.New("template package expands beyond 50 MiB")
		}
		files[name] = content
	}
	manifestBytes, ok := files["dbmock-template.yaml"]
	if !ok {
		return ValidatedPackage{}, errors.New("dbmock-template.yaml is required")
	}
	var manifest PackageManifest
	if err := yaml.Unmarshal(manifestBytes, &manifest); err != nil {
		return ValidatedPackage{}, fmt.Errorf("parse package manifest: %w", err)
	}
	if manifest.APIVersion != "dbmock.io/v1alpha1" || manifest.Kind != "DatabaseTemplate" {
		return ValidatedPackage{}, errors.New("unsupported template manifest kind or apiVersion")
	}
	slug := store.NormalizeTemplateSlug(manifest.Metadata.Slug)
	manifest.Metadata.Name = strings.TrimSpace(manifest.Metadata.Name)
	manifest.Metadata.Category = strings.TrimSpace(manifest.Metadata.Category)
	manifest.Spec.Version = strings.TrimSpace(manifest.Spec.Version)
	manifest.Spec.Image = strings.TrimSpace(manifest.Spec.Image)
	if slug == "" || manifest.Metadata.Name == "" || manifest.Metadata.Category == "" || manifest.Spec.Version == "" || manifest.Spec.Image == "" || manifest.Spec.DefaultPort < 1 || manifest.Spec.DefaultPort > 65535 {
		return ValidatedPackage{}, errors.New("template name, category, version, image and defaultPort are required")
	}
	if strings.ContainsAny(manifest.Spec.Version+manifest.Spec.Image, "\r\n\x00") {
		return ValidatedPackage{}, errors.New("template version and image must be single-line values")
	}
	if manifest.Spec.MinCPU <= 0 || manifest.Spec.MinMemory <= 0 || manifest.Spec.MinDisk <= 0 {
		return ValidatedPackage{}, errors.New("positive minimum resources are required")
	}
	composeName := path.Clean(manifest.Spec.ComposeFile)
	if composeName == "." {
		composeName = "docker-compose.yml"
	}
	compose, ok := files[composeName]
	if !ok {
		return ValidatedPackage{}, fmt.Errorf("Compose file %s is missing", composeName)
	}
	if len(compose) > 2*1024*1024 {
		return ValidatedPackage{}, errors.New("Compose file is too large")
	}
	upgradeScript := ""
	if manifest.Spec.UpgradeScript != "" {
		upgradeScript = path.Clean(manifest.Spec.UpgradeScript)
		if path.IsAbs(upgradeScript) || strings.HasPrefix(upgradeScript, "../") {
			return ValidatedPackage{}, errors.New("upgradeScript must be inside the template package")
		}
		if _, ok := files[upgradeScript]; !ok {
			return ValidatedPackage{}, fmt.Errorf("upgradeScript %s is missing", upgradeScript)
		}
	}
	var composeDocument any
	if err := yaml.Unmarshal(compose, &composeDocument); err != nil {
		return ValidatedPackage{}, fmt.Errorf("parse Compose YAML: %w", err)
	}
	risks := AnalyzeCompose(compose)
	if risks == nil {
		risks = make([]Risk, 0)
	}
	riskJSON, _ := json.Marshal(risks)
	manifestJSON, _ := json.Marshal(Manifest{Username: manifest.Spec.Username, Database: manifest.Spec.Database,
		Scheme: manifest.Spec.Scheme, JDBCScheme: manifest.Spec.JDBCScheme, ContainerPort: manifest.Spec.DefaultPort,
		HostTuning: manifest.Spec.HostTuning, UpgradeScript: upgradeScript})
	architectures := make([]string, 0, len(manifest.Spec.Architectures))
	seenArchitectures := make(map[string]struct{})
	if len(manifest.Spec.Architectures) == 0 {
		manifest.Spec.Architectures = []string{"amd64"}
	}
	for _, architecture := range manifest.Spec.Architectures {
		architecture = strings.ToLower(strings.TrimSpace(architecture))
		if architecture != "amd64" && architecture != "arm64" {
			return ValidatedPackage{}, fmt.Errorf("unsupported template architecture %q", architecture)
		}
		if _, exists := seenArchitectures[architecture]; exists {
			continue
		}
		seenArchitectures[architecture] = struct{}{}
		architectures = append(architectures, architecture)
	}
	return ValidatedPackage{Template: store.TemplateInput{Slug: slug, Name: manifest.Metadata.Name,
		NameZH: manifest.Metadata.NameZH, Description: manifest.Metadata.Description, Category: manifest.Metadata.Category,
		Tier: "custom", Builtin: false, Icon: manifest.Metadata.Icon, RiskReport: riskJSON}, Version: store.TemplateVersionInput{
		Version: manifest.Spec.Version, ImageReference: manifest.Spec.Image, Architectures: architectures,
		MinCPU: manifest.Spec.MinCPU, MinMemoryBytes: manifest.Spec.MinMemory, MinDiskBytes: manifest.Spec.MinDisk,
		DefaultPort: manifest.Spec.DefaultPort, ComposeTemplate: string(compose), Manifest: manifestJSON,
		RiskReport: riskJSON}, Files: files}, nil
}

type Risk struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

func AnalyzeCompose(content []byte) []Risk {
	text := strings.ToLower(string(content))
	checks := []struct{ needle, code, severity, message string }{
		{"privileged: true", "privileged", "critical", "A service runs in privileged mode"},
		{"network_mode: host", "host_network", "critical", "A service uses the host network"},
		{"/var/run/docker.sock", "docker_socket", "critical", "The Docker socket is mounted"},
		{"pid: host", "host_pid", "critical", "A service shares the host PID namespace"},
		{"ipc: host", "host_ipc", "critical", "A service shares the host IPC namespace"},
		{"cap_add:", "extra_capabilities", "warning", "A service adds Linux capabilities"},
		{"devices:", "host_devices", "warning", "A service accesses host devices"},
		{"/etc:/", "host_etc_mount", "critical", "The host /etc directory may be mounted"},
		{"/:/host", "host_root_mount", "critical", "The host root filesystem may be mounted"},
	}
	var risks []Risk
	for _, check := range checks {
		if strings.Contains(text, check.needle) {
			risks = append(risks, Risk{check.code, check.severity, check.message})
		}
	}
	if !strings.Contains(text, "dbmock.instance") {
		risks = append(risks, Risk{"missing_instance_label", "warning", "Compose services do not declare the dbmock.instance label"})
	}
	if !strings.Contains(text, "healthcheck:") {
		risks = append(risks, Risk{"missing_healthcheck", "warning", "Compose does not declare a health check"})
	}
	return risks
}

func PackageProjectFiles(filename string) (map[string][]byte, error) {
	if filename == "" {
		return map[string][]byte{}, nil
	}
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	result := make(map[string][]byte)
	for _, item := range reader.File {
		name := path.Clean(strings.ReplaceAll(item.Name, "\\", "/"))
		if item.FileInfo().IsDir() || name == "dbmock-template.yaml" || name == "docker-compose.yml" || name == "compose.yaml" {
			continue
		}
		if path.IsAbs(name) || strings.HasPrefix(name, "../") {
			return nil, fmt.Errorf("unsafe package path %q", item.Name)
		}
		handle, openErr := item.Open()
		if openErr != nil {
			return nil, openErr
		}
		content, readErr := io.ReadAll(io.LimitReader(handle, 10*1024*1024+1))
		_ = handle.Close()
		if readErr != nil {
			return nil, readErr
		}
		result[name] = content
	}
	return result, nil
}
