package api

import (
	"context"
	"io/fs"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/config"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/images"
	"github.com/pika/db-mock/internal/instances"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
	webassets "github.com/pika/db-mock/web"
)

type Server struct {
	config    config.Config
	store     *store.Store
	vault     *appcrypto.Vault
	auth      *auth.Service
	hosts     *hostops.Service
	docker    *hostops.Docker
	instances *instances.Service
	images    *images.Service
	tasks     *tasks.Manager
	logger    *slog.Logger
}

func New(cfg config.Config, target *store.Store, vault *appcrypto.Vault, authService *auth.Service,
	hostService *hostops.Service, docker *hostops.Docker, instanceService *instances.Service,
	imageService *images.Service, taskManager *tasks.Manager, logger *slog.Logger) *Server {
	return &Server{config: cfg, store: target, vault: vault, auth: authService, hosts: hostService, docker: docker,
		instances: instanceService, images: imageService, tasks: taskManager, logger: logger}
}

func (s *Server) Handler() http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RealIP, middleware.Compress(5), httpx.RequestMiddleware(s.logger, s.config.PublicURL))
	router.Route("/api/v1", func(r chi.Router) {
		r.Get("/health", s.health)
		r.Get("/setup/status", s.setupStatus)
		r.Post("/setup", s.setup)
		r.Post("/auth/login", s.login)
		r.Group(func(r chi.Router) {
			r.Use(s.auth.Middleware)
			r.Get("/auth/me", s.me)
			r.Patch("/auth/me", s.updateMe)
			r.Post("/auth/logout", s.logout)
			r.Get("/dashboard", s.dashboard)
			r.Route("/users", s.userRoutes)
			r.Route("/projects", s.projectRoutes)
			r.Route("/hosts", s.hostRoutes)
			r.Route("/registries", s.registryRoutes)
			r.Route("/templates", s.templateRoutes)
			r.Route("/images", s.imageRoutes)
			r.Route("/instances", s.instanceRoutes)
			r.Route("/tasks", s.taskRoutes)
			r.Route("/alerts", s.alertRoutes)
			r.Route("/webhooks", s.webhookRoutes)
			r.Route("/audit", s.auditRoutes)
			r.Route("/settings", s.settingRoutes)
		})
	})
	s.serveFrontend(router)
	return router
}

func (s *Server) serveFrontend(router *chi.Mux) {
	assets := webassets.Files()
	fileServer := http.FileServer(http.FS(assets))
	router.NotFound(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		name := strings.TrimPrefix(r.URL.Path, "/")
		if name != "" {
			if _, err := fs.Stat(assets, name); err == nil {
				fileServer.ServeHTTP(w, r)
				return
			}
		}
		content, err := fs.ReadFile(assets, "index.html")
		if err != nil {
			http.Error(w, "frontend unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(content)
	})
	router.Get("/", func(w http.ResponseWriter, r *http.Request) {
		content, _ := fs.ReadFile(assets, "index.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(content)
	})
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	err := s.store.Pool().Ping(ctx)
	if err != nil {
		httpx.JSON(w, http.StatusServiceUnavailable, map[string]any{"status": "unhealthy", "database": false})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"status": "healthy", "database": true, "version": Version})
}

var Version = "dev"
