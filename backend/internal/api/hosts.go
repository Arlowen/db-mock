package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/store"
)

func (s *Server) hostRoutes(r chi.Router) {
	r.Get("/", s.listHosts)
	r.With(requireOperator).Post("/test", s.testHost)
	r.With(requireOperator).Post("/", s.createHost)
	r.Get("/{id}", s.getHost)
	r.With(requireOperator).Put("/{id}", s.updateHost)
	r.With(requireOperator).Delete("/{id}", s.deleteHost)
	r.With(requireOperator).Post("/{id}/actions/{action}", s.hostAction)
}

type hostRequest struct {
	HostID             *uuid.UUID        `json:"hostId"`
	ProjectID          *uuid.UUID        `json:"projectId"`
	Name               string            `json:"name"`
	SSHAddress         string            `json:"sshAddress"`
	SSHPort            int               `json:"sshPort"`
	SSHUser            string            `json:"sshUser"`
	AuthType           string            `json:"authType"`
	Credential         string            `json:"credential"`
	Passphrase         string            `json:"passphrase"`
	HostKey            string            `json:"hostKey"`
	VerificationToken  string            `json:"verificationToken"`
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
	input.Name = strings.TrimSpace(input.Name)
	input.SSHAddress = strings.TrimSpace(input.SSHAddress)
	input.SSHUser = strings.TrimSpace(input.SSHUser)
	input.AuthType = strings.TrimSpace(input.AuthType)
	input.ConnectionAddress = strings.TrimSpace(input.ConnectionAddress)
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if input.ConnectionAddress == "" {
		input.ConnectionAddress = input.SSHAddress
	}
	if input.DataRoot == "" {
		input.DataRoot = "/opt/dbmock"
	}
	input.DataRoot = path.Clean(input.DataRoot)
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
	storedHostKey := ""
	if input.HostID != nil {
		existing, getErr := s.store.GetHost(r.Context(), *input.HostID)
		if getErr != nil {
			httpx.Error(w, r, getErr)
			return
		}
		id = existing.ID
		storedHostKey = existing.HostKey
	}
	encrypted, err := s.encryptedHostCredential(id, input)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	host := domain.Host{ID: id, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser,
		AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: storedHostKey, DataRoot: input.DataRoot,
		PortStart: input.PortStart, PortEnd: input.PortEnd}
	probe, err := s.docker.Probe(r.Context(), host)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	status, statusMessage := hostops.ProbeStatus(probe)
	if status == "unsupported" || status == "degraded" {
		httpx.Error(w, r, fmt.Errorf("%w: %s", domain.ErrUnavailable, statusMessage))
		return
	}
	token, expiresAt, err := issueHostVerification(s.vault, input, input.HostID, probe, time.Now())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	httpx.JSON(w, http.StatusOK, struct {
		hostops.ProbeResult
		VerificationToken     string    `json:"verificationToken"`
		VerificationExpiresAt time.Time `json:"verificationExpiresAt"`
	}{ProbeResult: probe, VerificationToken: token, VerificationExpiresAt: expiresAt})
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
	receipt, err := verifyHostVerification(s.vault, input.VerificationToken, input, nil, time.Now())
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	if input.ManageDocker && !receipt.PasswordlessSudo {
		httpx.Error(w, r, fmt.Errorf("%w: passwordless sudo is required when Docker management is enabled", domain.ErrConflict))
		return
	}
	input.HostKey = receipt.HostKey
	encrypted, err := s.encryptedHostCredential(id, input)
	if err != nil {
		httpx.Error(w, r, err)
		return
	}
	labels, _ := json.Marshal(input.Labels)
	host, err := s.store.CreateHost(r.Context(), store.HostInput{ID: id, ProjectID: input.ProjectID, Name: input.Name, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser, AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: input.HostKey, ConnectionAddress: input.ConnectionAddress, DataRoot: input.DataRoot, PortStart: input.PortStart, PortEnd: input.PortEnd, ManageDocker: input.ManageDocker, ProxyHTTP: input.ProxyHTTP, ProxyHTTPS: input.ProxyHTTPS, ProxyNoProxy: input.ProxyNoProxy, Maintenance: input.Maintenance, AutoRestartDefault: hostAutoRestart(input), Labels: labels, DataRootWritable: receipt.DataRootWritable, PortProbeAvailable: receipt.PortProbeAvailable, AvailablePort: receipt.FirstAvailablePort})
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
	requiresVerification := hostVerificationRequired(existing, input)
	dataRootWritable, portProbeAvailable, availablePort := existing.DataRootWritable, existing.PortProbeAvailable, existing.AvailablePort
	if requiresVerification {
		if input.Credential == "" {
			httpx.Error(w, r, fmt.Errorf("%w: enter the SSH credential and test the changed host settings", domain.ErrInvalid))
			return
		}
		receipt, verifyErr := verifyHostVerification(s.vault, input.VerificationToken, input, &id, time.Now())
		if verifyErr != nil {
			httpx.Error(w, r, verifyErr)
			return
		}
		if input.ManageDocker && !receipt.PasswordlessSudo {
			httpx.Error(w, r, fmt.Errorf("%w: passwordless sudo is required when Docker management is enabled", domain.ErrConflict))
			return
		}
		input.HostKey = receipt.HostKey
		dataRootWritable, portProbeAvailable, availablePort = receipt.DataRootWritable, receipt.PortProbeAvailable, receipt.FirstAvailablePort
	} else {
		input.HostKey = existing.HostKey
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
	host, err := s.store.UpdateHost(r.Context(), id, store.HostInput{ProjectID: input.ProjectID, Name: input.Name, SSHAddress: input.SSHAddress, SSHPort: input.SSHPort, SSHUser: input.SSHUser, AuthType: input.AuthType, EncryptedCredential: encrypted, HostKey: input.HostKey, ConnectionAddress: input.ConnectionAddress, DataRoot: input.DataRoot, PortStart: input.PortStart, PortEnd: input.PortEnd, ManageDocker: input.ManageDocker, ProxyHTTP: input.ProxyHTTP, ProxyHTTPS: input.ProxyHTTPS, ProxyNoProxy: input.ProxyNoProxy, Maintenance: input.Maintenance, AutoRestartDefault: hostAutoRestart(input), Labels: labels, DataRootWritable: dataRootWritable, PortProbeAvailable: portProbeAvailable, AvailablePort: availablePort})
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
