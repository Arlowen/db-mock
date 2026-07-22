package templates

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"unicode/utf8"

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
		Version          string              `yaml:"version"`
		Image            string              `yaml:"image"`
		Architectures    []string            `yaml:"architectures"`
		ComposeFile      string              `yaml:"composeFile"`
		DefaultPort      int                 `yaml:"defaultPort"`
		MinCPU           float64             `yaml:"minCpu"`
		MinMemory        int64               `yaml:"minMemoryBytes"`
		MinDisk          int64               `yaml:"minDiskBytes"`
		Username         string              `yaml:"username"`
		Database         string              `yaml:"database"`
		Scheme           string              `yaml:"scheme"`
		JDBCScheme       string              `yaml:"jdbcScheme"`
		HostTuning       []string            `yaml:"hostTuning"`
		UpgradeScript    string              `yaml:"upgradeScript"`
		Parameters       []TemplateParameter `yaml:"parameters"`
		ResourceProfiles []ResourceProfile   `yaml:"resourceProfiles"`
	} `yaml:"spec"`
}

type ValidatedPackage struct {
	Template store.TemplateInput
	Version  store.TemplateVersionInput
	Files    map[string][]byte
}

const templateManifestPath = "dbmock-template.yaml"

func cleanPackagePath(value string) (string, error) {
	if !utf8.ValidString(value) || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("unsafe package path %q", value)
	}
	clean := path.Clean(strings.ReplaceAll(value, "\\", "/"))
	if clean == "." || path.IsAbs(clean) || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("unsafe package path %q", value)
	}
	for _, character := range clean {
		if character < 0x20 || character == 0x7f {
			return "", fmt.Errorf("unsafe package path %q", value)
		}
	}
	return clean, nil
}

func isPlatformOwnedProjectPath(name string) bool {
	component := strings.ToLower(strings.SplitN(name, "/", 2)[0])
	return component == ".env" || component == "data" || component == "runtime" ||
		strings.HasPrefix(component, ".dbmock-managed-files")
}

func validatePackageFileTopology(files map[string]string) error {
	for folded, name := range files {
		for parent := path.Dir(folded); parent != "."; parent = path.Dir(parent) {
			if ancestor, exists := files[parent]; exists {
				return fmt.Errorf("template package path %q conflicts with child path %q", ancestor, name)
			}
		}
	}
	return nil
}

func packageComposePath(manifest PackageManifest) (string, error) {
	value := manifest.Spec.ComposeFile
	if strings.TrimSpace(value) == "" {
		value = "docker-compose.yml"
	}
	return cleanPackagePath(value)
}

func ValidatePackage(filename string) (ValidatedPackage, error) {
	return validatePackage(filename, false)
}

func validatePackage(filename string, ignorePlatformOwnedFiles bool) (ValidatedPackage, error) {
	reader, err := zip.OpenReader(filename)
	if err != nil {
		return ValidatedPackage{}, fmt.Errorf("open template zip: %w", err)
	}
	defer reader.Close()
	if len(reader.File) > 256 {
		return ValidatedPackage{}, errors.New("template package contains too many files")
	}
	files := make(map[string][]byte)
	seenPaths := make(map[string]string)
	filePaths := make(map[string]string)
	var total int64
	for _, item := range reader.File {
		name, pathErr := cleanPackagePath(item.Name)
		if pathErr != nil {
			return ValidatedPackage{}, pathErr
		}
		platformOwned := isPlatformOwnedProjectPath(name)
		if platformOwned && !ignorePlatformOwnedFiles {
			return ValidatedPackage{}, fmt.Errorf("template package path %q is owned by DB Mock", name)
		}
		folded := strings.ToLower(name)
		if !platformOwned {
			if previous, exists := seenPaths[folded]; exists {
				return ValidatedPackage{}, fmt.Errorf("template package contains case-colliding paths %q and %q", previous, name)
			}
			seenPaths[folded] = name
		}
		if item.FileInfo().IsDir() {
			continue
		}
		if !platformOwned {
			filePaths[folded] = name
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
		if platformOwned {
			continue
		}
		files[name] = content
	}
	if err := validatePackageFileTopology(filePaths); err != nil {
		return ValidatedPackage{}, err
	}
	manifestBytes, ok := files[templateManifestPath]
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
	parameters, err := NormalizeTemplateParameters(manifest.Spec.Parameters)
	if err != nil {
		return ValidatedPackage{}, err
	}
	resourceProfiles, err := NormalizeResourceProfiles(manifest.Spec.ResourceProfiles, manifest.Spec.MinCPU, manifest.Spec.MinMemory, manifest.Spec.MinDisk)
	if err != nil {
		return ValidatedPackage{}, err
	}
	composeName, err := packageComposePath(manifest)
	if err != nil {
		return ValidatedPackage{}, errors.New("composeFile must be inside the template package")
	}
	for name := range files {
		component := strings.ToLower(strings.SplitN(name, "/", 2)[0])
		if component != "compose.yaml" || name == composeName {
			continue
		}
		if !ignorePlatformOwnedFiles {
			return ValidatedPackage{}, fmt.Errorf("template package path %q is owned by DB Mock", name)
		}
		delete(files, name)
	}
	compose, ok := files[composeName]
	if !ok {
		return ValidatedPackage{}, fmt.Errorf("compose file %s is missing", composeName)
	}
	if len(compose) > 2*1024*1024 {
		return ValidatedPackage{}, errors.New("compose file is too large")
	}
	if len(parameters) > 0 && !strings.Contains(string(compose), "{{ .ExtraEnvironment }}") {
		return ValidatedPackage{}, errors.New("templates with parameters must render {{ .ExtraEnvironment }} inside a service environment block")
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
	risks := AnalyzeCompose(compose)
	if risks == nil {
		risks = make([]Risk, 0)
	}
	riskJSON, _ := json.Marshal(risks)
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
	_, _, err = ResolveTemplateParameters(parameters, templateParameterValidationValues(parameters), nil, true)
	if err != nil {
		return ValidatedPackage{}, fmt.Errorf("validate template parameters: %w", err)
	}
	imageReferences, err := ComposeImageReferences(slug, string(compose), manifest.Spec.Image, templateParameterPlacementEnvironment(parameters))
	if err != nil {
		return ValidatedPackage{}, fmt.Errorf("validate Compose images: %w", err)
	}
	manifestJSON, _ := json.Marshal(Manifest{Username: manifest.Spec.Username, Database: manifest.Spec.Database,
		Scheme: manifest.Spec.Scheme, JDBCScheme: manifest.Spec.JDBCScheme, ContainerPort: manifest.Spec.DefaultPort,
		HostTuning: manifest.Spec.HostTuning, UpgradeScript: upgradeScript, ImageReferences: imageReferences,
		Parameters: parameters, ResourceProfiles: resourceProfiles})
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
	validated, err := validatePackage(filename, true)
	if err != nil {
		return nil, err
	}
	var manifest PackageManifest
	if err = yaml.Unmarshal(validated.Files[templateManifestPath], &manifest); err != nil {
		return nil, fmt.Errorf("parse package manifest: %w", err)
	}
	composeName, err := packageComposePath(manifest)
	if err != nil {
		return nil, err
	}
	result := make(map[string][]byte)
	for name, content := range validated.Files {
		if name == templateManifestPath || name == composeName {
			continue
		}
		result[name] = content
	}
	return result, nil
}
