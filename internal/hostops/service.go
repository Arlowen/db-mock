package hostops

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
)

type Service struct {
	store  *store.Store
	docker *Docker
	tasks  *tasks.Manager
}

type HostTaskPayload struct {
	HostID uuid.UUID `json:"hostId"`
}

func NewService(target *store.Store, docker *Docker, manager *tasks.Manager) *Service {
	service := &Service{store: target, docker: docker, tasks: manager}
	manager.Register("host.probe", service.handleProbe)
	manager.Register("host.install_docker", service.handleInstall)
	manager.Register("host.upgrade_docker", service.handleUpgrade)
	manager.Register("host.configure_proxy", service.handleConfigureProxy)
	return service
}

func (s *Service) Enqueue(ctx context.Context, userID, hostID uuid.UUID, kind string) (domain.Task, error) {
	allowed := map[string]bool{"probe": true, "install_docker": true, "upgrade_docker": true, "configure_proxy": true}
	if !allowed[kind] {
		return domain.Task{}, domain.ErrInvalid
	}
	host, err := s.store.GetHost(ctx, hostID)
	if err != nil {
		return domain.Task{}, err
	}
	if (kind == "install_docker" || kind == "upgrade_docker" || kind == "configure_proxy") && !host.ManageDocker {
		return domain.Task{}, fmt.Errorf("%w: Docker management is disabled for this host", domain.ErrForbidden)
	}
	task, err := s.store.CreateTask(ctx, store.TaskInput{Kind: "host." + kind, ResourceType: "host", ResourceID: &hostID,
		RequestedBy: userID, HostID: &hostID, Payload: HostTaskPayload{HostID: hostID}})
	if err == nil {
		s.tasks.Wake()
	}
	return task, err
}

func (s *Service) payload(task domain.Task) (domain.Host, error) {
	var payload HostTaskPayload
	if err := tasks.DecodePayload(task, &payload); err != nil {
		return domain.Host{}, err
	}
	return s.store.GetHost(context.Background(), payload.HostID)
}

func (s *Service) handleProbe(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	host, err := s.payload(task)
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 10, "connect", "Connecting to host over SSH", true); err != nil {
		return nil, err
	}
	probe, err := s.docker.Probe(ctx, host)
	if err != nil {
		_ = s.store.SetHostStatus(context.Background(), host.ID, "offline", err.Error(), false)
		return nil, err
	}
	status := "online"
	message := ""
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		status = "needs_docker"
		message = "Docker Engine or Compose v2 is not available"
	}
	if probe.OS != "linux" && probe.OS != "darwin" {
		status = "unsupported"
		message = "Only Linux and macOS are supported"
	}
	if probe.Architecture != "amd64" && probe.Architecture != "arm64" {
		status = "unsupported"
		message = "Only amd64 and arm64 are supported"
	}
	if err = runtime.Stage(ctx, 80, "persist", "Saving detected host capabilities", false); err != nil {
		return nil, err
	}
	err = s.store.UpdateHostProbe(ctx, host.ID, store.HostProbe{HostKey: probe.HostKey, OS: probe.OS, Distro: probe.Distro,
		Architecture: probe.Architecture, DockerVersion: probe.DockerVersion, ComposeVersion: probe.ComposeVersion,
		CPUCount: probe.CPUCount, MemoryBytes: probe.MemoryBytes, DiskTotalBytes: probe.DiskTotalBytes,
		DiskFreeBytes: probe.DiskFreeBytes, Status: status, StatusMessage: message})
	if err != nil {
		return nil, err
	}
	return map[string]any{"hostId": host.ID, "status": status, "fingerprint": probe.HostKey}, nil
}

func (s *Service) handleInstall(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	return s.install(ctx, runtime, task, false)
}
func (s *Service) handleUpgrade(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	return s.install(ctx, runtime, task, true)
}
func (s *Service) handleConfigureProxy(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	host, err := s.payload(task)
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 20, "docker", "Applying Docker daemon proxy and restarting Docker", false); err != nil {
		return nil, err
	}
	if err = s.docker.ConfigureProxy(ctx, host); err != nil {
		return nil, err
	}
	return map[string]any{"hostId": host.ID, "configured": true}, nil
}
func (s *Service) install(ctx context.Context, runtime *tasks.Runtime, task domain.Task, upgrade bool) (any, error) {
	host, err := s.payload(task)
	if err != nil {
		return nil, err
	}
	if !host.ManageDocker {
		return nil, domain.ErrForbidden
	}
	label := "Installing Docker Engine and Compose"
	if upgrade {
		label = "Upgrading Docker Engine and Compose"
	}
	if err = runtime.Stage(ctx, 10, "docker", label, false); err != nil {
		return nil, err
	}
	result, err := s.docker.InstallOrUpgrade(ctx, host, upgrade)
	if err != nil {
		return nil, err
	}
	_ = runtime.Log(ctx, "info", result.Stdout)
	if host.ProxyHTTP != "" || host.ProxyHTTPS != "" || host.ProxyNoProxy != "" {
		if err = s.docker.ConfigureProxy(ctx, host); err != nil {
			return nil, err
		}
	}
	if err = runtime.Stage(ctx, 80, "probe", "Verifying Docker installation", false); err != nil {
		return nil, err
	}
	probe, err := s.docker.Probe(ctx, host)
	if err != nil {
		return nil, err
	}
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		return nil, errors.New("Docker verification failed; reconnect the SSH user after docker group membership changes")
	}
	err = s.store.UpdateHostProbe(ctx, host.ID, store.HostProbe{HostKey: probe.HostKey, OS: probe.OS, Distro: probe.Distro,
		Architecture: probe.Architecture, DockerVersion: probe.DockerVersion, ComposeVersion: probe.ComposeVersion,
		CPUCount: probe.CPUCount, MemoryBytes: probe.MemoryBytes, DiskTotalBytes: probe.DiskTotalBytes,
		DiskFreeBytes: probe.DiskFreeBytes, Status: "online"})
	return map[string]any{"hostId": host.ID, "dockerVersion": probe.DockerVersion, "composeVersion": probe.ComposeVersion}, err
}
