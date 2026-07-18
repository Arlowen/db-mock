package httpx

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequestMiddlewareDisablesAPICaching(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := RequestMiddleware(logger, "")(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	apiRecorder := httptest.NewRecorder()
	handler.ServeHTTP(apiRecorder, httptest.NewRequest(http.MethodGet, "/api/v1/auth/me", nil))
	if got := apiRecorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("expected API responses to disable caching, got %q", got)
	}

	assetRecorder := httptest.NewRecorder()
	handler.ServeHTTP(assetRecorder, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if got := assetRecorder.Header().Get("Cache-Control"); got != "" {
		t.Fatalf("expected static assets to retain their own cache policy, got %q", got)
	}
}
