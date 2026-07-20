package api

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/templates"
)

func (s *Server) registryRoutes(r chi.Router) {
	r.Get("/", s.listRegistries)
	r.Post("/", s.createRegistry)
	r.Put("/{id}", s.updateRegistry)
	r.Post("/{id}/test", s.testRegistry)
	r.Delete("/{id}", s.deleteRegistry)
}

type registryRequest struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	CACertificate string `json:"caCertificate"`
	ClearPassword bool   `json:"clearPassword"`
	ClearCA       bool   `json:"clearCaCertificate"`
}

func validateRegistry(input registryRequest) error {
	parsed, err := url.Parse(input.URL)
	if strings.TrimSpace(input.Name) == "" || err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return domain.ErrInvalid
	}
	return nil
}

func normalizeRegistryURL(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

func (s *Server) listRegistries(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListRegistries(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) createRegistry(w http.ResponseWriter, r *http.Request) {
	var input registryRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err := validateRegistry(input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.URL = normalizeRegistryURL(input.URL)
	id := uuid.New()
	password, err := s.sealOptional(input.Password, "registry:"+id.String()+":password")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	ca, err := s.sealOptional(input.CACertificate, "registry:"+id.String()+":ca")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.CreateRegistry(r.Context(), store.RegistryInput{ID: id, Name: input.Name, URL: input.URL, Username: input.Username, EncryptedPassword: password, EncryptedCACertificate: ca})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "registry.create", "registry", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, item)
}
func (s *Server) updateRegistry(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input registryRequest
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = validateRegistry(input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.URL = normalizeRegistryURL(input.URL)
	password, err := s.sealOptional(input.Password, "registry:"+id.String()+":password")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	ca, err := s.sealOptional(input.CACertificate, "registry:"+id.String()+":ca")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.UpdateRegistry(r.Context(), id, store.RegistryInput{Name: input.Name, URL: input.URL, Username: input.Username, EncryptedPassword: password, EncryptedCACertificate: ca, ClearPassword: input.ClearPassword, ClearCACertificate: input.ClearCA})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "registry.update", "registry", &id, item.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, item)
}

type registryTestResult struct {
	Status     string    `json:"status"`
	Message    string    `json:"message"`
	StatusCode int       `json:"statusCode,omitempty"`
	CheckedAt  time.Time `json:"checkedAt"`
}

func newRegistryProbeClient(caCertificate string) (*http.Client, error) {
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if strings.TrimSpace(caCertificate) != "" && !roots.AppendCertsFromPEM([]byte(caCertificate)) {
		return nil, domain.ErrInvalid
	}
	return &http.Client{
		Timeout: 15 * time.Second,
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			TLSClientConfig: &tls.Config{
				MinVersion: tls.VersionTLS12,
				RootCAs:    roots,
			},
		},
	}, nil
}

func probeRegistry(ctx context.Context, client *http.Client, registryURL, username, password string) registryTestResult {
	checkedAt := time.Now().UTC()
	endpoint := strings.TrimRight(registryURL, "/") + "/v2/"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return registryTestResult{Status: "offline", Message: "registry_connection_failed", CheckedAt: checkedAt}
	}
	if username != "" || password != "" {
		request.SetBasicAuth(username, password)
	}
	response, err := client.Do(request)
	if err != nil {
		return registryTestResult{Status: "offline", Message: "registry_connection_failed", CheckedAt: checkedAt}
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	result := registryTestResult{StatusCode: response.StatusCode, CheckedAt: checkedAt}
	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		result.Status, result.Message = "online", "registry_reachable"
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		result.Status = "degraded"
		if username == "" && password == "" {
			result.Message = "registry_authentication_required"
		} else {
			result.Message = "registry_authentication_failed"
		}
	default:
		result.Status, result.Message = "degraded", "registry_http_error"
	}
	return result
}

func (s *Server) testRegistry(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetRegistry(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	password := ""
	if item.EncryptedPassword != "" {
		plain, openErr := s.vault.Open(item.EncryptedPassword, "registry:"+item.ID.String()+":password")
		if openErr != nil {
			httpx.Error(w, r, openErr)
			return
		}
		password = string(plain)
	}
	caCertificate := ""
	if item.EncryptedCACertificate != "" {
		plain, openErr := s.vault.Open(item.EncryptedCACertificate, "registry:"+item.ID.String()+":ca")
		if openErr != nil {
			httpx.Error(w, r, openErr)
			return
		}
		caCertificate = string(plain)
	}
	client, clientErr := newRegistryProbeClient(caCertificate)
	result := registryTestResult{Status: "degraded", Message: "registry_invalid_ca_certificate", CheckedAt: time.Now().UTC()}
	if clientErr == nil {
		result = probeRegistry(r.Context(), client, item.URL, item.Username, password)
	}
	if err = s.store.SetRegistryTestResult(r.Context(), id, result.Status, result.Message, result.StatusCode, result.CheckedAt); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	auditResult := "failure"
	if result.Status == "online" {
		auditResult = "success"
	}
	_ = s.audit(r, actor, "registry.test", "registry", &id, item.Name, nil, auditResult, result.Message)
	httpx.JSON(w, http.StatusOK, result)
}

func (s *Server) deleteRegistry(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.store.DeleteRegistry(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "registry.delete", "registry", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
func (s *Server) sealOptional(value, context string) (string, error) {
	if value == "" {
		return "", nil
	}
	return s.vault.Seal([]byte(value), context)
}

func (s *Server) templateRoutes(r chi.Router) {
	r.Get("/", s.listTemplates)
	r.Post("/custom", s.uploadTemplate)
	r.Delete("/{id}", s.deleteTemplate)
}
func (s *Server) listTemplates(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListTemplates(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) uploadTemplate(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(60 << 20); err != nil {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	file, header, err := r.FormFile("package")
	if err != nil {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	defer file.Close()
	temporary, err := os.CreateTemp(s.config.ArtifactDirectory, "template-*.zip")
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	temporaryPath := temporary.Name()
	defer func() { _ = os.Remove(temporaryPath) }()
	if _, err = io.Copy(temporary, io.LimitReader(file, 60<<20)); err != nil {
		_ = temporary.Close()
		httpx.Error(w, r, err)
		return
	}
	_ = temporary.Close()
	validated, err := templates.ValidatePackage(temporaryPath)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	directory := filepath.Join(s.config.ArtifactDirectory, "templates")
	if err = os.MkdirAll(directory, 0o750); err != nil {
		httpx.Error(w, r, err)
		return
	}
	destination := filepath.Join(directory, uuid.NewString()+".zip")
	if err = os.Rename(temporaryPath, destination); err != nil {
		httpx.Error(w, r, err)
		return
	}
	validated.Version.PackagePath = destination
	item, err := s.store.UpsertTemplate(r.Context(), validated.Template, validated.Version)
	if err != nil {
		_ = os.Remove(destination)
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "template.upload", "template", &item.ID, header.Filename, nil, "success", "")
	httpx.JSON(w, http.StatusCreated, item)
}
func (s *Server) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if err = s.store.DeleteTemplate(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "template.delete", "template", &id, "", nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}
