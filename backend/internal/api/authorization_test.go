package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestAuthenticatedRouteSurfaceExcludesNonMVPAPIs(t *testing.T) {
	router := chi.NewRouter()
	(&Server{}).authenticatedRoutes(router)
	routes := map[string]bool{}
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		routes[method+" "+route] = true
		if strings.HasPrefix(route, "/images") || strings.HasPrefix(route, "/registries") ||
			strings.HasPrefix(route, "/users") || strings.HasPrefix(route, "/projects") ||
			strings.HasPrefix(route, "/alerts") || strings.HasPrefix(route, "/webhooks") ||
			strings.HasPrefix(route, "/audit") {
			t.Errorf("retired route is still registered: %s %s", method, route)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !routes[http.MethodGet+" /templates/"] {
		t.Fatalf("built-in template list route is missing: %#v", routes)
	}
	for _, retired := range []string{
		http.MethodPost + " /templates/custom",
		http.MethodDelete + " /templates/{id}",
		http.MethodPut + " /settings/{key}",
		http.MethodPatch + " /instances/{id}",
		http.MethodPost + " /instances/batch-cleanup-decisions",
		http.MethodPost + " /instances/{id}/cleanup-decision",
		http.MethodGet + " /instances/{id}/metrics",
		http.MethodPost + " /instances/{id}/backups",
		http.MethodGet + " /instances/{id}/backup-policy",
		http.MethodPut + " /instances/{id}/backup-policy",
		http.MethodPost + " /instances/{id}/backups/{backupId}/restore",
	} {
		if routes[retired] {
			t.Fatalf("retired route is still registered: %s", retired)
		}
	}
}

func TestRetiredInstanceActionsAreRejectedBeforeStoreAccess(t *testing.T) {
	for _, action := range []string{"upgrade", "reconfigure", "backup", "restore"} {
		router := chi.NewRouter()
		router.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				actor := auth.Actor{User: domain.User{Role: domain.RoleAdmin}}
				next.ServeHTTP(w, r.WithContext(auth.WithActor(r.Context(), actor)))
			})
		})
		(&Server{}).instanceRoutes(router)
		response := httptest.NewRecorder()
		path := "/11111111-1111-4111-8111-111111111111/actions/" + action
		router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, nil))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("retired action %s status = %d, want %d; body=%s", action, response.Code, http.StatusBadRequest, response.Body.String())
		}
	}
}

func TestViewerIsDeniedProtectedRoutesBeforeHandlersRun(t *testing.T) {
	tests := []struct {
		name   string
		method string
		path   string
		routes func(*Server, chi.Router)
	}{
		{name: "host probe", method: http.MethodPost, path: "/test", routes: (*Server).hostRoutes},
		{name: "instance create", method: http.MethodPost, path: "/", routes: (*Server).instanceRoutes},
		{name: "instance batch stop", method: http.MethodPost, path: "/batch-actions/stop", routes: (*Server).instanceRoutes},
		{name: "instance batch restart", method: http.MethodPost, path: "/batch-actions/restart", routes: (*Server).instanceRoutes},
		{name: "credential reveal", method: http.MethodGet, path: "/11111111-1111-4111-8111-111111111111/connection", routes: (*Server).instanceRoutes},
		{name: "task cancel", method: http.MethodPost, path: "/11111111-1111-4111-8111-111111111111/cancel", routes: (*Server).taskRoutes},
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
