package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
	Development         bool
	AutoGenerateKeyFile string
}

func Load() (Config, error) {
	cfg := Config{
		ListenAddress:       env("DBMOCK_LISTEN_ADDRESS", ":8080"),
		DatabaseURL:         env("DBMOCK_DATABASE_URL", "postgres://dbmock:dbmock@localhost:5432/dbmock?sslmode=disable"),
		ArtifactDirectory:   env("DBMOCK_ARTIFACT_DIR", "./data/artifacts"),
		PublicURL:           strings.TrimRight(env("DBMOCK_PUBLIC_URL", "http://localhost:8080"), "/"),
		TLSCertFile:         os.Getenv("DBMOCK_TLS_CERT_FILE"),
		TLSKeyFile:          os.Getenv("DBMOCK_TLS_KEY_FILE"),
		SessionDuration:     envDuration("DBMOCK_SESSION_DURATION", 30*24*time.Hour),
		MonitorInterval:     envDuration("DBMOCK_MONITOR_INTERVAL", 30*time.Second),
		MetricsRetention:    envDuration("DBMOCK_METRICS_RETENTION", 7*24*time.Hour),
		MaxUploadBytes:      envInt64("DBMOCK_MAX_UPLOAD_BYTES", 50*1024*1024*1024),
		TaskWorkers:         int(envInt64("DBMOCK_TASK_WORKERS", 4)),
		Timezone:            env("DBMOCK_TIMEZONE", "Asia/Shanghai"),
		Development:         envBool("DBMOCK_DEVELOPMENT", false),
		AutoGenerateKeyFile: env("DBMOCK_MASTER_KEY_FILE", "./data/master.key"),
	}

	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, errors.New("DBMOCK_TLS_CERT_FILE and DBMOCK_TLS_KEY_FILE must be configured together")
	}
	if cfg.TaskWorkers < 1 || cfg.TaskWorkers > 32 {
		return Config{}, errors.New("DBMOCK_TASK_WORKERS must be between 1 and 32")
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

func envDuration(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt64(name string, fallback int64) int64 {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envBool(name string, fallback bool) bool {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}
