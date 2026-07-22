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

	"github.com/pika/db-mock/internal/domain"
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
	Username      string            `json:"username" yaml:"username"`
	Database      string            `json:"database" yaml:"database"`
	Scheme        string            `json:"scheme" yaml:"scheme"`
	JDBCScheme    string            `json:"jdbcScheme" yaml:"jdbcScheme"`
	ContainerPort int               `json:"containerPort" yaml:"containerPort"`
	HostTuning    []string          `json:"hostTuning" yaml:"hostTuning"`
	UpgradeScript string            `json:"upgradeScript,omitempty" yaml:"upgradeScript,omitempty"`
	Environment   map[string]string `json:"environment" yaml:"environment"`
}

func ParseManifest(raw json.RawMessage) (Manifest, error) {
	var result Manifest
	if err := json.Unmarshal(raw, &result); err != nil {
		return result, err
	}
	return result, nil
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
