package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/store"
)

func (s *Server) hostRoutes(r chi.Router) {
	r.Get("/", s.listHosts)
	r.Post("/test", s.testHost)
	r.Post("/", s.createHost)
	r.Get("/{id}", s.getHost)
	r.Put("/{id}", s.updateHost)
	r.Delete("/{id}", s.deleteHost)
	r.Post("/{id}/actions/{action}", s.hostAction)
}

type hostRequest struct {
	ProjectID          *uuid.UUID        `json:"projectId"`
	Name               string            `json:"name"`
	SSHAddress         string            `json:"sshAddress"`
	SSHPort            int               `json:"sshPort"`
	SSHUser            string            `json:"sshUser"`
	AuthType           string            `json:"authType"`
	Credential         string            `json:"credential"`
	Passphrase         string            `json:"passphrase"`
	HostKey            string            `json:"hostKey"`
	ConnectionAddress  string            `json:"connectionAddress"`
	DataRoot           string            `json:"dataRoot"`
	PortStart          int               `json:"portStart"`
	PortEnd            int               `json:"portEnd"`
	ManageDocker       bool              `json:"manageDocker"`
	ProxyHTTP          string            `json:"proxyHttp"`
	ProxyHTTPS         string            `json:"proxyHttps"`
	ProxyNoProxy       string            `json:"proxyNoProxy"`
	Maintenance        bool              `json:"maintenance"`
	AutoRestartDefault *bool             `json:"autoRestartDefault"`
	Labels             map[string]string `json:"labels"`
}

func (s *Server) listHosts(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListHosts(r.Context())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items})
}
func (s *Server) getHost(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	item, err := s.store.GetHost(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, item)
}

func normalizeHostInput(input *hostRequest) {
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if input.ConnectionAddress == "" {
		input.ConnectionAddress = input.SSHAddress
	}
	if input.DataRoot == "" {
		input.DataRoot = "/opt/dbmock"
	}
	if input.PortStart == 0 {
		input.PortStart = 20000
	}
	if input.PortEnd == 0 {
		input.PortEnd = 40000
	}
	if input.AuthType == "" {
		input.AuthType = "private_key"
	}
}
func hostAutoRestart(input hostRequest) bool {
	if input.AutoRestartDefault == nil {
		return true
	}
	return *input.AutoRestartDefault
}

func validateHostInput(input hostRequest) error {
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.SSHAddress) == "" || strings.TrimSpace(input.SSHUser) == "" {
		return domain.ErrInvalid
	}
	if input.AuthType != "password" && input.AuthType != "private_key" {
		return fmt.Errorf("%w: unsupported SSH authentication type", domain.ErrInvalid)
	}
	root := path.Clean(input.DataRoot)
	if !path.IsAbs(root) || root == "/" || root == "." {
		return fmt.Errorf("%w: dataRoot must be a dedicated absolute path", domain.ErrInvalid)
	}
	if input.SSHPort < 1 || input.SSHPort > 65535 || input.PortStart < 1 || input.PortEnd > 65535 || input.PortStart > input.PortEnd {
		return fmt.Errorf("%w: invalid SSH port or instance port pool", domain.ErrInvalid)
	}
	return nil
}

func (s *Server) encryptedHostCredential(id uuid.UUID, input hostRequest) (string, error) {
	envelope, _ := json.Marshal(map[string]string{"secret": input.Credential, "passphrase": input.Passphrase})
	return s.vault.Seal(envelope, "host:"+id.String())
}

func (s *Server) testHost(w http.ResponseWriter, r *http.Request) {
	var input hostRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	normalizeHostInput(&input)
	if strings.TrimSpace(input.Name) == "" {
		input.Name = "connection-test"
	}
	if err := validateHostInput(input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if input.Credential == "" {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	id := uuid.New()
	encrypted, err := s.encryptedHostCredential(id, input)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	host := domain.Host{ID: id, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser,
		AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: input.HostKey, DataRoot: input.DataRoot}
	probe, err := s.docker.Probe(r.Context(), host)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, probe)
}

func (s *Server) createHost(w http.ResponseWriter, r *http.Request) {
	var input hostRequest
	if err := httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	normalizeHostInput(&input)
	if err := validateHostInput(input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if input.Credential == "" {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	id := uuid.New()
	if input.HostKey == "" {
		httpx.Error(w, r, fmt.Errorf("%w: test the SSH connection and confirm its host key first", domain.ErrInvalid))
		return
	}
	encrypted, err := s.encryptedHostCredential(id, input)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	labels, _ := json.Marshal(input.Labels)
	host, err := s.store.CreateHost(r.Context(), store.HostInput{ID: id, ProjectID: input.ProjectID, Name: input.Name, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser, AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: input.HostKey, ConnectionAddress: input.ConnectionAddress, DataRoot: input.DataRoot, PortStart: input.PortStart, PortEnd: input.PortEnd, ManageDocker: input.ManageDocker, ProxyHTTP: input.ProxyHTTP, ProxyHTTPS: input.ProxyHTTPS, ProxyNoProxy: input.ProxyNoProxy, Maintenance: input.Maintenance, AutoRestartDefault: hostAutoRestart(input), Labels: labels})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	task, taskErr := s.hosts.Enqueue(r.Context(), actor.User.ID, host.ID, "probe")
	if taskErr != nil {
		_ = s.audit(r, actor, "host.create", "host", &host.ID, host.Name, nil, "failure", taskErr.Error())
		httpx.Error(w, r, taskErr)
		return
	}
	_ = s.audit(r, actor, "host.create", "host", &host.ID, host.Name, &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, map[string]any{"host": host, "task": task})
}

func (s *Server) updateHost(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	existing, err := s.store.GetHost(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input hostRequest
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	normalizeHostInput(&input)
	if err = validateHostInput(input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	encrypted := ""
	if input.Credential != "" {
		encrypted, err = s.encryptedHostCredential(id, input)
		if err != nil {
			httpx.Error(w, r, err)
			return
		}
	}
	labels, _ := json.Marshal(input.Labels)
	host, err := s.store.UpdateHost(r.Context(), id, store.HostInput{ProjectID: input.ProjectID, Name: input.Name, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser, AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: input.HostKey, ConnectionAddress: input.ConnectionAddress, DataRoot: input.DataRoot, PortStart: input.PortStart, PortEnd: input.PortEnd, ManageDocker: input.ManageDocker, ProxyHTTP: input.ProxyHTTP, ProxyHTTPS: input.ProxyHTTPS, ProxyNoProxy: input.ProxyNoProxy, Maintenance: input.Maintenance, AutoRestartDefault: hostAutoRestart(input), Labels: labels})
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.auditWithChanges(r, actor, "host.update", "host", &id, host.Name, nil, "success", "", hostAuditChanges(existing, host, input))
	httpx.JSON(w, http.StatusOK, host)
}

func (s *Server) deleteHost(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	host, err := s.store.GetHost(r.Context(), id)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	var input struct {
		ConfirmName string `json:"confirmName"`
	}
	if err = httpx.Decode(r, &input); err != nil {
		httpx.Error(w, r, err)
		return
	}
	if strings.TrimSpace(input.ConfirmName) != host.Name {
		httpx.Error(w, r, domain.ErrInvalid)
		return
	}
	if err = s.store.DeleteHost(r.Context(), id); err != nil {
		httpx.Error(w, r, err)
		return
	}
	actor, _ := auth.ActorFrom(r.Context())
	_ = s.audit(r, actor, "host.delete", "host", &id, host.Name, nil, "success", "")
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) hostAction(w http.ResponseWriter, r *http.Request) {
	id, err := httpx.UUIDParam(chi.URLParam(r, "id"))
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	action := chi.URLParam(r, "action")
	actor, _ := auth.ActorFrom(r.Context())
	task, err := s.hosts.Enqueue(r.Context(), actor.User.ID, id, action)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	_ = s.audit(r, actor, "host."+action, "host", &id, "", &task.ID, "success", "")
	httpx.JSON(w, http.StatusAccepted, task)
}
