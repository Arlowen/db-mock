package config

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	platformsettings "github.com/pika/db-mock/internal/settings"
)

type Config struct {
	ListenAddress       string
	DatabaseURL         string
	MasterKey           []byte
	ArtifactDirectory   string
	PublicURL           string
	TLSCertFile         string
	TLSKeyFile          string
	SessionDuration     time.Duration
	MonitorInterval     time.Duration
	MetricsRetention    time.Duration
	MaxUploadBytes      int64
	TaskWorkers         int
	Timezone            string
	SecureCookies       bool
	AutoGenerateKeyFile string
}

func Load() (Config, error) {
	sessionDuration, err := envDuration("DBMOCK_SESSION_DURATION", 30*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	monitorInterval, err := envDuration("DBMOCK_MONITOR_INTERVAL", 30*time.Second)
	if err != nil {
		return Config{}, err
	}
	metricsRetention, err := envDuration("DBMOCK_METRICS_RETENTION", 7*24*time.Hour)
	if err != nil {
		return Config{}, err
	}
	maxUploadBytes, err := envInt64("DBMOCK_MAX_UPLOAD_BYTES", 50*1024*1024*1024)
	if err != nil {
		return Config{}, err
	}
	taskWorkers, err := envInt64("DBMOCK_TASK_WORKERS", 4)
	if err != nil {
		return Config{}, err
	}
	publicURL, secureCookies, err := parsePublicURL(env("DBMOCK_PUBLIC_URL", "http://localhost:8080"))
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		ListenAddress:       env("DBMOCK_LISTEN_ADDRESS", ":8080"),
		DatabaseURL:         env("DBMOCK_DATABASE_URL", "postgres://dbmock:dbmock@localhost:5432/dbmock?sslmode=disable"),
		ArtifactDirectory:   env("DBMOCK_ARTIFACT_DIR", "./data/artifacts"),
		PublicURL:           publicURL,
		TLSCertFile:         os.Getenv("DBMOCK_TLS_CERT_FILE"),
		TLSKeyFile:          os.Getenv("DBMOCK_TLS_KEY_FILE"),
		SessionDuration:     sessionDuration,
		MonitorInterval:     monitorInterval,
		MetricsRetention:    metricsRetention,
		MaxUploadBytes:      maxUploadBytes,
		TaskWorkers:         int(taskWorkers),
		Timezone:            strings.TrimSpace(env("DBMOCK_TIMEZONE", "Asia/Shanghai")),
		SecureCookies:       secureCookies,
		AutoGenerateKeyFile: env("DBMOCK_MASTER_KEY_FILE", "./data/master.key"),
	}

	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, errors.New("DBMOCK_TLS_CERT_FILE and DBMOCK_TLS_KEY_FILE must be configured together")
	}
	if cfg.TLSCertFile != "" && !cfg.SecureCookies {
		return Config{}, errors.New("DBMOCK_PUBLIC_URL must use https when built-in TLS is enabled")
	}
	if cfg.TLSCertFile != "" {
		if _, err := tls.LoadX509KeyPair(cfg.TLSCertFile, cfg.TLSKeyFile); err != nil {
			return Config{}, fmt.Errorf("load DBMOCK_TLS_CERT_FILE and DBMOCK_TLS_KEY_FILE: %w", err)
		}
	}
	if cfg.TaskWorkers < 1 || cfg.TaskWorkers > 32 {
		return Config{}, errors.New("DBMOCK_TASK_WORKERS must be between 1 and 32")
	}
	if cfg.MonitorInterval < 5*time.Second || cfg.MonitorInterval > time.Hour {
		return Config{}, errors.New("DBMOCK_MONITOR_INTERVAL must be between 5s and 1h")
	}
	if cfg.MetricsRetention < 24*time.Hour || cfg.MetricsRetention > 365*24*time.Hour || cfg.MetricsRetention%(24*time.Hour) != 0 {
		return Config{}, errors.New("DBMOCK_METRICS_RETENTION must be a whole number of days between 24h and 8760h")
	}
	if cfg.MaxUploadBytes < platformsettings.MinUploadBytes || cfg.MaxUploadBytes > platformsettings.MaxUploadBytes {
		return Config{}, fmt.Errorf("DBMOCK_MAX_UPLOAD_BYTES must be between %d and %d bytes", platformsettings.MinUploadBytes, platformsettings.MaxUploadBytes)
	}
	if err := platformsettings.ValidateTimezone(cfg.Timezone); err != nil {
		return Config{}, errors.New("DBMOCK_TIMEZONE must be a valid IANA timezone name")
	}

	key, err := loadMasterKey(os.Getenv("DBMOCK_MASTER_KEY"), cfg.AutoGenerateKeyFile)
	if err != nil {
		return Config{}, err
	}
	cfg.MasterKey = key

	if err := os.MkdirAll(cfg.ArtifactDirectory, 0o750); err != nil {
		return Config{}, fmt.Errorf("create artifact directory: %w", err)
	}
	return cfg, nil
}

func loadMasterKey(encoded, path string) ([]byte, error) {
	if encoded != "" {
		key, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(key) != 32 {
			return nil, errors.New("DBMOCK_MASTER_KEY must be base64 for exactly 32 bytes")
		}
		return key, nil
	}
	if data, err := os.ReadFile(path); err == nil {
		key, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(data)))
		if decodeErr != nil || len(key) != 32 {
			return nil, fmt.Errorf("invalid master key file %s", path)
		}
		return key, nil
	} else if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read master key: %w", err)
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("generate master key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return nil, fmt.Errorf("create master key directory: %w", err)
	}
	if err := os.WriteFile(path, []byte(base64.StdEncoding.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, fmt.Errorf("write master key: %w", err)
	}
	return key, nil
}

func env(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func envDuration(name string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be a valid duration: %w", name, err)
	}
	if parsed <= 0 {
		return 0, fmt.Errorf("%s must be greater than zero", name)
	}
	return parsed, nil
}

func envInt64(name string, fallback int64) (int64, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s must be a base-10 integer: %w", name, err)
	}
	return parsed, nil
}

func parsePublicURL(value string) (string, bool, error) {
	parsed, err := url.ParseRequestURI(strings.TrimSpace(value))
	if err != nil || parsed.Host == "" || parsed.Hostname() == "" {
		return "", false, errors.New("DBMOCK_PUBLIC_URL must be an absolute http or https URL")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false, errors.New("DBMOCK_PUBLIC_URL must use the http or https scheme")
	}
	if parsed.User != nil {
		return "", false, errors.New("DBMOCK_PUBLIC_URL must not contain user information")
	}
	if port := parsed.Port(); port != "" {
		value, portErr := strconv.Atoi(port)
		if portErr != nil || value < 1 || value > 65535 {
			return "", false, errors.New("DBMOCK_PUBLIC_URL port must be between 1 and 65535")
		}
	}
	if (parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" {
		return "", false, errors.New("DBMOCK_PUBLIC_URL must not contain a path")
	}
	if parsed.ForceQuery || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false, errors.New("DBMOCK_PUBLIC_URL must not contain a query or fragment")
	}
	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/"), parsed.Scheme == "https", nil
}
