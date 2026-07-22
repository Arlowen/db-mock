package templates

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	texttemplate "text/template"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"gopkg.in/yaml.v3"
)

type RenderContext struct {
	InstanceID       string
	ShortID          string
	TemplateSlug     string
	ProjectLabel     string
	Image            string
	BindAddress      string
	HostPort         int
	DataPath         string
	CPU              string
	MemoryBytes      int64
	RestartPolicy    string
	ExtraEnvironment string
}

type Manifest struct {
	Username        string            `json:"username" yaml:"username"`
	Database        string            `json:"database" yaml:"database"`
	Scheme          string            `json:"scheme" yaml:"scheme"`
	JDBCScheme      string            `json:"jdbcScheme" yaml:"jdbcScheme"`
	ContainerPort   int               `json:"containerPort" yaml:"containerPort"`
	HostTuning      []string          `json:"hostTuning" yaml:"hostTuning"`
	UpgradeScript   string            `json:"upgradeScript,omitempty" yaml:"upgradeScript,omitempty"`
	Environment     map[string]string `json:"environment" yaml:"environment"`
	ImageReferences []string          `json:"imageReferences,omitempty" yaml:"imageReferences,omitempty"`
}

func ParseManifest(raw json.RawMessage) (Manifest, error) {
	var result Manifest
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, err
	}
	return result, nil
}

// RequiredImageReferences returns the complete immutable image set required by
// a template version. Versions created before imageReferences was introduced
// remain compatible and fall back to their primary image reference.
func RequiredImageReferences(version domain.TemplateVersion) ([]string, error) {
	if len(version.Manifest) == 0 {
		return uniqueImageReferences([]string{version.ImageReference})
	}
	manifest, err := ParseManifest(version.Manifest)
	if err != nil {
		return nil, fmt.Errorf("parse template manifest: %w", err)
	}
	return uniqueImageReferences(append([]string{version.ImageReference}, manifest.ImageReferences...))
}

// ComposeImageReferences renders a template with safe placeholder values and
// extracts every service image. It is used at catalog/package ingestion time so
// runtime image validation never has to guess about multi-service Compose files.
func ComposeImageReferences(templateSlug, composeTemplate, primaryImage string) ([]string, error) {
	template := domain.Template{Slug: templateSlug}
	version := domain.TemplateVersion{ImageReference: primaryImage, ComposeTemplate: composeTemplate}
	instance := domain.Instance{ID: uuid.MustParse("00000000-0000-4000-8000-000000000001"), HostPort: 5432,
		BindAddress: "127.0.0.1", CPU: 1, MemoryBytes: 1024 * 1024 * 1024, AutoRestart: true,
		RemoteDirectory: "/opt/dbmock/instances/template-validation"}
	rendered, err := RenderCompose(template, version, instance, nil)
	if err != nil {
		return nil, err
	}
	var document struct {
		Services map[string]struct {
			Image string `yaml:"image"`
		} `yaml:"services"`
	}
	if err = yaml.Unmarshal(rendered, &document); err != nil {
		return nil, fmt.Errorf("parse rendered Compose YAML: %w", err)
	}
	if len(document.Services) == 0 {
		return nil, errors.New("compose must declare at least one service")
	}
	serviceNames := make([]string, 0, len(document.Services))
	for name := range document.Services {
		serviceNames = append(serviceNames, name)
	}
	sort.Strings(serviceNames)
	references := make([]string, 0, len(serviceNames))
	for _, name := range serviceNames {
		image := strings.TrimSpace(document.Services[name].Image)
		if image == "" {
			return nil, fmt.Errorf("compose service %q must declare an image", name)
		}
		references = append(references, image)
	}
	references, err = uniqueImageReferences(references)
	if err != nil {
		return nil, err
	}
	if !containsString(references, strings.TrimSpace(primaryImage)) {
		return nil, errors.New("compose services must use the manifest primary image")
	}
	// Keep the primary image first for stable API display and task progress.
	ordered := []string{strings.TrimSpace(primaryImage)}
	for _, reference := range references {
		if reference != ordered[0] {
			ordered = append(ordered, reference)
		}
	}
	return ordered, nil
}

func uniqueImageReferences(references []string) ([]string, error) {
	result := make([]string, 0, len(references))
	seen := make(map[string]struct{}, len(references))
	for _, reference := range references {
		reference = strings.TrimSpace(reference)
		if reference == "" {
			return nil, errors.New("template image reference cannot be empty")
		}
		if _, exists := seen[reference]; exists {
			continue
		}
		seen[reference] = struct{}{}
		result = append(result, reference)
	}
	return result, nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func RenderCompose(template domain.Template, version domain.TemplateVersion, instance domain.Instance, extraEnvironment map[string]string) ([]byte, error) {
	if version.ComposeTemplate == "" {
		return nil, errors.New("template has no Compose content")
	}
	keys := make([]string, 0, len(extraEnvironment))
	for key := range extraEnvironment {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var extra strings.Builder
	for _, key := range keys {
		if !validEnvironmentKey(key) {
			return nil, fmt.Errorf("invalid environment key %q", key)
		}
		if reservedEnvironmentKey(key) {
			return nil, fmt.Errorf("environment key %q is reserved", key)
		}
		extra.WriteString("      " + key + ": " + strconv.Quote(extraEnvironment[key]) + "\n")
	}
	short := strings.ReplaceAll(instance.ID.String(), "-", "")[:12]
	project := "none"
	if instance.ProjectID != nil {
		project = instance.ProjectID.String()
	}
	restartPolicy := "no"
	if instance.AutoRestart {
		restartPolicy = "unless-stopped"
	}
	ctx := RenderContext{InstanceID: instance.ID.String(), ShortID: short, TemplateSlug: template.Slug,
		ProjectLabel: project, Image: version.ImageReference, BindAddress: instance.BindAddress, HostPort: instance.HostPort,
		DataPath: path.Join(instance.RemoteDirectory, "data"), CPU: strconv.FormatFloat(instance.CPU, 'f', 2, 64),
		MemoryBytes: instance.MemoryBytes, RestartPolicy: restartPolicy, ExtraEnvironment: extra.String()}
	parsed, err := texttemplate.New("compose").Option("missingkey=error").Parse(version.ComposeTemplate)
	if err != nil {
		return nil, fmt.Errorf("parse Compose template: %w", err)
	}
	var output bytes.Buffer
	if err := parsed.Execute(&output, ctx); err != nil {
		return nil, fmt.Errorf("render Compose template: %w", err)
	}
	return output.Bytes(), nil
}

func EnvFile(username, password, database string) ([]byte, error) {
	for _, value := range []string{username, password, database} {
		if strings.ContainsAny(value, "\r\n\x00") {
			return nil, errors.New("environment values cannot contain line breaks")
		}
	}
	return []byte("DB_USERNAME=" + escapeEnv(username) + "\nDB_PASSWORD=" + escapeEnv(password) + "\nDB_NAME=" + escapeEnv(database) + "\n"), nil
}

func Connection(template domain.Template, version domain.TemplateVersion, instance domain.Instance, address, password string) domain.InstanceConnection {
	manifest, _ := ParseManifest(version.Manifest)
	username := instance.DatabaseUsername
	database := instance.DatabaseName
	userInfo := url.UserPassword(username, password)
	uri := ""
	if manifest.Scheme != "" {
		uri = manifest.Scheme + "://" + userInfo.String() + "@" + address + ":" + strconv.Itoa(instance.HostPort)
		if database != "" {
			uri += "/" + url.PathEscape(database)
		}
	}
	jdbc := ""
	if manifest.JDBCScheme != "" {
		if manifest.JDBCScheme == "oracle:thin" {
			jdbc = "jdbc:oracle:thin:@//" + address + ":" + strconv.Itoa(instance.HostPort) + "/" + url.PathEscape(database)
		} else {
			jdbc = "jdbc:" + manifest.JDBCScheme + "://" + address + ":" + strconv.Itoa(instance.HostPort)
			if database != "" {
				jdbc += "/" + url.PathEscape(database)
			}
		}
	}
	return domain.InstanceConnection{Address: address, Port: instance.HostPort, Username: username, Password: password,
		Database: database, URI: uri, JDBC: jdbc}
}

func escapeEnv(value string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(value, `\`, `\\`), `"`, `\"`) + `"`
}

func validEnvironmentKey(key string) bool {
	if key == "" {
		return false
	}
	for i, r := range key {
		if !(r == '_' || r >= 'A' && r <= 'Z' || r >= 'a' && r <= 'z' || i > 0 && r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

func reservedEnvironmentKey(key string) bool {
	switch key {
	case "DBMOCK_DB_USERNAME", "DBMOCK_DB_PASSWORD", "DBMOCK_DB_NAME":
		return true
	default:
		return false
	}
}
