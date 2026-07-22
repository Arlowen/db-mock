package config

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func configureValidEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("DBMOCK_LISTEN_ADDRESS", ":8080")
	t.Setenv("DBMOCK_DATABASE_URL", "postgres://dbmock:dbmock@localhost:5432/dbmock?sslmode=disable")
	t.Setenv("DBMOCK_ARTIFACT_DIR", t.TempDir())
	t.Setenv("DBMOCK_PUBLIC_URL", "http://localhost:8080")
	t.Setenv("DBMOCK_TLS_CERT_FILE", "")
	t.Setenv("DBMOCK_TLS_KEY_FILE", "")
	t.Setenv("DBMOCK_SESSION_DURATION", "720h")
	t.Setenv("DBMOCK_MONITOR_INTERVAL", "30s")
	t.Setenv("DBMOCK_METRICS_RETENTION", "168h")
	t.Setenv("DBMOCK_MAX_UPLOAD_BYTES", "53687091200")
	t.Setenv("DBMOCK_TASK_WORKERS", "4")
	t.Setenv("DBMOCK_TIMEZONE", "Asia/Shanghai")
	t.Setenv("DBMOCK_MASTER_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("DBMOCK_MASTER_KEY_FILE", t.TempDir()+"/unused.key")
}

func TestLoadParsesStrictTypedEnvironment(t *testing.T) {
	configureValidEnvironment(t)
	t.Setenv("DBMOCK_SESSION_DURATION", "48h")
	t.Setenv("DBMOCK_MONITOR_INTERVAL", "45s")
	t.Setenv("DBMOCK_METRICS_RETENTION", "240h")
	t.Setenv("DBMOCK_MAX_UPLOAD_BYTES", "1073741824")
	t.Setenv("DBMOCK_TASK_WORKERS", "8")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SessionDuration != 48*time.Hour || cfg.MonitorInterval != 45*time.Second || cfg.MetricsRetention != 240*time.Hour {
		t.Fatalf("unexpected durations: %#v", cfg)
	}
	if cfg.MaxUploadBytes != 1073741824 || cfg.TaskWorkers != 8 {
		t.Fatalf("unexpected typed settings: %#v", cfg)
	}
}

func TestLoadRejectsInvalidTypedEnvironment(t *testing.T) {
	tests := []struct {
		name  string
		value string
	}{
		{name: "DBMOCK_SESSION_DURATION", value: "thirty days"},
		{name: "DBMOCK_SESSION_DURATION", value: "0s"},
		{name: "DBMOCK_MONITOR_INTERVAL", value: "-1s"},
		{name: "DBMOCK_MONITOR_INTERVAL", value: "2s"},
		{name: "DBMOCK_METRICS_RETENTION", value: "forever"},
		{name: "DBMOCK_METRICS_RETENTION", value: "25h"},
		{name: "DBMOCK_MAX_UPLOAD_BYTES", value: "fifty gigabytes"},
		{name: "DBMOCK_TASK_WORKERS", value: "four"},
		{name: "DBMOCK_TASK_WORKERS", value: "0"},
	}
	for _, test := range tests {
		t.Run(test.name+"_"+test.value, func(t *testing.T) {
			configureValidEnvironment(t)
			t.Setenv(test.name, test.value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), test.name) {
				t.Fatalf("Load() error = %v, want an error naming %s", err, test.name)
			}
		})
	}
}

func TestLoadValidatesPublicURLAndSecureCookies(t *testing.T) {
	configureValidEnvironment(t)
	t.Setenv("DBMOCK_PUBLIC_URL", "https://dbmock.example.com:8443/")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicURL != "https://dbmock.example.com:8443" || !cfg.SecureCookies {
		t.Fatalf("HTTPS public URL was not normalized securely: %#v", cfg)
	}

	invalid := []string{
		"dbmock.example.com",
		"ftp://dbmock.example.com",
		"https://user:password@dbmock.example.com",
		"https://dbmock.example.com:70000",
		"https://dbmock.example.com/control-plane",
		"https://dbmock.example.com?source=invalid",
		"https://dbmock.example.com#invalid",
	}
	for _, value := range invalid {
		t.Run(value, func(t *testing.T) {
			configureValidEnvironment(t)
			t.Setenv("DBMOCK_PUBLIC_URL", value)
			_, loadErr := Load()
			if loadErr == nil || !strings.Contains(loadErr.Error(), "DBMOCK_PUBLIC_URL") {
				t.Fatalf("Load() error = %v, want DBMOCK_PUBLIC_URL validation failure", loadErr)
			}
		})
	}
}

func TestLoadRequiresHTTPSPublicURLForBuiltInTLS(t *testing.T) {
	configureValidEnvironment(t)
	t.Setenv("DBMOCK_TLS_CERT_FILE", "/etc/dbmock/tls/server.crt")
	t.Setenv("DBMOCK_TLS_KEY_FILE", "/etc/dbmock/tls/server.key")
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "DBMOCK_PUBLIC_URL must use https") {
		t.Fatalf("Load() error = %v, want HTTPS public URL requirement", err)
	}
}

func TestLoadRejectsInvalidBuiltInTLSMaterial(t *testing.T) {
	configureValidEnvironment(t)
	t.Setenv("DBMOCK_PUBLIC_URL", "https://dbmock.example.com")
	directory := t.TempDir()
	certificate := filepath.Join(directory, "server.crt")
	privateKey := filepath.Join(directory, "server.key")
	if err := os.WriteFile(certificate, []byte("not a certificate"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(privateKey, []byte("not a private key"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("DBMOCK_TLS_CERT_FILE", certificate)
	t.Setenv("DBMOCK_TLS_KEY_FILE", privateKey)
	_, err := Load()
	if err == nil || !strings.Contains(err.Error(), "DBMOCK_TLS_CERT_FILE and DBMOCK_TLS_KEY_FILE") {
		t.Fatalf("Load() error = %v, want TLS key-pair validation failure", err)
	}
}
