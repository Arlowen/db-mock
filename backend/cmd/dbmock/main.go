package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pika/db-mock/internal/api"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/config"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	appdb "github.com/pika/db-mock/internal/db"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/images"
	"github.com/pika/db-mock/internal/instances"
	"github.com/pika/db-mock/internal/monitor"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
	"github.com/pika/db-mock/internal/templates"
	"github.com/pika/db-mock/internal/webhooks"
)

var version = "dev"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load()
	if err != nil {
		logger.Error("load configuration", "error", err)
		os.Exit(1)
	}
	root, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := openDatabase(root, cfg.DatabaseURL, logger)
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	defer pool.Close()
	target := store.New(pool)
	if err := templates.Seed(root, target); err != nil {
		logger.Error("seed built-in templates", "error", err)
		os.Exit(1)
	}
	vault, err := appcrypto.NewVault(cfg.MasterKey)
	if err != nil {
		logger.Error("initialize credential vault", "error", err)
		os.Exit(1)
	}
	runner := hostops.NewManager(vault)
	docker := hostops.NewDocker(runner)
	taskManager := tasks.New(target, logger, cfg.TaskWorkers)
	hostService := hostops.NewService(target, docker, taskManager)
	instanceService := instances.NewService(target, vault, docker, taskManager)
	imageService := images.New(target, cfg.ArtifactDirectory, cfg.MaxUploadBytes)
	if err := taskManager.Start(root); err != nil {
		logger.Error("start task workers", "error", err)
		os.Exit(1)
	}
	monitor.New(target, docker, logger, cfg.MonitorInterval, cfg.MetricsRetention).Start(root)
	webhooks.New(target, vault, logger).Start(root)
	secureCookie := cfg.TLSCertFile != ""
	authService := auth.New(target, cfg.SessionDuration, secureCookie)
	api.Version = version
	handler := api.New(cfg, target, vault, authService, hostService, docker, instanceService, imageService, taskManager, logger).Handler()
	server := &http.Server{Addr: cfg.ListenAddress, Handler: handler, ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout: 60 * time.Second, WriteTimeout: 10 * time.Minute, IdleTimeout: 2 * time.Minute,
		MaxHeaderBytes: 1 << 20}
	serverErrors := make(chan error, 1)
	go func() {
		logger.Info("DB Mock listening", "address", cfg.ListenAddress, "version", version, "tls", secureCookie)
		if secureCookie {
			serverErrors <- server.ListenAndServeTLS(cfg.TLSCertFile, cfg.TLSKeyFile)
		} else {
			serverErrors <- server.ListenAndServe()
		}
	}()
	select {
	case <-root.Done():
	case err := <-serverErrors:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.Error("HTTP server stopped", "error", err)
		}
	}
	stop()
	shutdown, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdown)
	taskManager.Wait()
	logger.Info("DB Mock stopped")
}

func openDatabase(ctx context.Context, databaseURL string, logger *slog.Logger) (*pgxpool.Pool, error) {
	var last error
	for attempt := 1; attempt <= 30; attempt++ {
		pool, err := appdb.Open(ctx, databaseURL)
		if err == nil {
			return pool, nil
		}
		last = err
		logger.Warn("database is not ready", "attempt", attempt, "error", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Second):
		}
	}
	return nil, last
}
