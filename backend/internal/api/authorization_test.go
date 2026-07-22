package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
)

func TestRoleMiddlewareEnforcesServerSideAuthorization(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	tests := []struct {
		name       string
		role       string
		middleware func(http.Handler) http.Handler
		want       int
	}{
		{name: "admin can administer", role: domain.RoleAdmin, middleware: requireAdmin, want: http.StatusNoContent},
		{name: "operator cannot administer", role: domain.RoleOperator, middleware: requireAdmin, want: http.StatusForbidden},
		{name: "operator can operate", role: domain.RoleOperator, middleware: requireOperator, want: http.StatusNoContent},
		{name: "viewer cannot operate", role: domain.RoleViewer, middleware: requireOperator, want: http.StatusForbidden},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/v1/test", nil)
			request = request.WithContext(auth.WithActor(request.Context(), auth.Actor{User: domain.User{Role: test.role}}))
			response := httptest.NewRecorder()
			test.middleware(next).ServeHTTP(response, request)
			if response.Code != test.want {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, test.want, response.Body.String())
			}
		})
	}
}

func TestViewerIsDeniedProtectedRoutesBeforeHandlersRun(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		routes func(*Server, chi.Router)
	}{
		{name: "users", method: http.MethodGet, path: "/", routes: (*Server).userRoutes},
		{name: "project create", method: http.MethodPost, path: "/", routes: (*Server).projectRoutes},
		{name: "host probe", method: http.MethodPost, path: "/test", routes: (*Server).hostRoutes},
		{name: "registry create", method: http.MethodPost, path: "/", routes: (*Server).registryRoutes},
		{name: "template upload", method: http.MethodPost, path: "/custom", routes: (*Server).templateRoutes},
		{name: "image upload", method: http.MethodPost, path: "/uploads", routes: (*Server).imageRoutes},
		{name: "instance create", method: http.MethodPost, path: "/", routes: (*Server).instanceRoutes},
		{name: "credential reveal", method: http.MethodGet, path: "/11111111-1111-4111-8111-111111111111/connection", routes: (*Server).instanceRoutes},
		{name: "task cancel", method: http.MethodPost, path: "/11111111-1111-4111-8111-111111111111/cancel", routes: (*Server).taskRoutes},
		{name: "alert acknowledge", method: http.MethodPost, path: "/11111111-1111-4111-8111-111111111111/acknowledged", routes: (*Server).alertRoutes},
		{name: "webhooks", method: http.MethodGet, path: "/", routes: (*Server).webhookRoutes},
		{name: "audit", method: http.MethodGet, path: "/", routes: (*Server).auditRoutes},
		{name: "settings update", method: http.MethodPut, path: "/timezone", routes: (*Server).settingRoutes},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					actor := auth.Actor{User: domain.User{Role: domain.RoleViewer}}
					next.ServeHTTP(w, r.WithContext(auth.WithActor(r.Context(), actor)))
				})
			})
			test.routes(&Server{}, router)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
			}
		})
	}
}

func TestOperatorIsDeniedAdministratorOnlyRoutes(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		routes func(*Server, chi.Router)
	}{
		{name: "users", method: http.MethodGet, path: "/", routes: (*Server).userRoutes},
		{name: "clear audit", method: http.MethodPost, path: "/clear", routes: (*Server).auditRoutes},
		{name: "update settings", method: http.MethodPut, path: "/timezone", routes: (*Server).settingRoutes},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := chi.NewRouter()
			router.Use(func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					actor := auth.Actor{User: domain.User{Role: domain.RoleOperator}}
					next.ServeHTTP(w, r.WithContext(auth.WithActor(r.Context(), actor)))
				})
			})
			test.routes(&Server{}, router)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(test.method, test.path, nil))
			if response.Code != http.StatusForbidden {
				t.Fatalf("status = %d, want %d; body=%s", response.Code, http.StatusForbidden, response.Body.String())
			}
		})
	}
}
