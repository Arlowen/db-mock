package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestValidateRegistry(t *testing.T) {
	tests := []struct {
		name  string
		input registryRequest
		valid bool
	}{
		{name: "https registry", input: registryRequest{Name: "Harbor", URL: "https://harbor.example.com"}, valid: true},
		{name: "http registry", input: registryRequest{Name: "Local", URL: "http://registry.local:5000/"}, valid: true},
		{name: "missing name", input: registryRequest{URL: "https://registry.example.com"}},
		{name: "invalid scheme", input: registryRequest{Name: "Registry", URL: "file:///tmp/registry"}},
		{name: "path not supported", input: registryRequest{Name: "Registry", URL: "https://registry.example.com/project"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateRegistry(test.input)
			if test.valid && err != nil {
				t.Fatalf("expected valid registry, got %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected registry validation to fail")
			}
		})
	}
}

func TestProbeRegistry(t *testing.T) {
	tests := []struct {
		name        string
		username    string
		password    string
		handler     http.HandlerFunc
		wantStatus  string
		wantMessage string
	}{
		{name: "reachable", handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }, wantStatus: "online", wantMessage: "registry_reachable"},
		{name: "authentication required", handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) }, wantStatus: "degraded", wantMessage: "registry_authentication_required"},
		{name: "authentication failed", username: "ci", password: "wrong", handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusUnauthorized) }, wantStatus: "degraded", wantMessage: "registry_authentication_failed"},
		{name: "registry error", handler: func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) }, wantStatus: "degraded", wantMessage: "registry_http_error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(test.handler)
			defer server.Close()
			result := probeRegistry(context.Background(), server.Client(), server.URL, test.username, test.password)
			if result.Status != test.wantStatus || result.Message != test.wantMessage {
				t.Fatalf("got status=%s message=%s", result.Status, result.Message)
			}
		})
	}
}

func TestProbeRegistryConnectionFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	client := server.Client()
	server.Close()
	result := probeRegistry(context.Background(), client, url, "", "")
	if result.Status != "offline" || result.Message != "registry_connection_failed" {
		t.Fatalf("got status=%s message=%s", result.Status, result.Message)
	}
}

func TestNewRegistryProbeClientRejectsInvalidCA(t *testing.T) {
	if _, err := newRegistryProbeClient("not a certificate"); err == nil {
		t.Fatal("expected invalid CA certificate to fail")
	}
}
