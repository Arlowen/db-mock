package hostops

import (
	"context"
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

const (
	DataRootUnavailableMessage  = "The managed data root is not writable by the SSH user"
	PortProbeUnavailableMessage = "ss, lsof, or netstat is required to inspect the instance port pool"
)

func ProbeStatus(probe ProbeResult) (string, string) {
	if probe.OS != "linux" && probe.OS != "darwin" {
		return "unsupported", "Only Linux and macOS are supported"
	}
	if probe.Architecture != "amd64" && probe.Architecture != "arm64" {
		return "unsupported", "Only amd64 and arm64 are supported"
	}
	if !probe.DataRootWritable {
		return "degraded", DataRootUnavailableMessage
	}
	if !probe.PortProbeAvailable {
		return "unsupported", PortProbeUnavailableMessage
	}
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		return "needs_docker", DockerUnavailableMessage
	}
	return "online", ""
}

func NewService(target *store.Store, docker *Docker, manager *tasks.Manager) *Service {
	service := &Service{store: target, docker: docker, tasks: manager}
	manager.Register("host.probe", service.handleProbe)
	for _, kind := range []string{"host.install_docker", "host.upgrade_docker", "host.configure_proxy"} {
		manager.RegisterCancellation(kind, func(context.Context, domain.Task) (*store.QueuedTaskRecovery, error) {
			return nil, nil
		})
	}
	return service
}

func (s *Service) Enqueue(ctx context.Context, userID, hostID uuid.UUID, kind string) (domain.Task, error) {
	if kind != "probe" {
		return domain.Task{}, domain.ErrInvalid
	}
	_, err := s.store.GetHost(ctx, hostID)
	if err != nil {
		return domain.Task{}, err
	}
	active, err := s.store.HasActiveResourceTask(ctx, "host", hostID)
	if err != nil {
		return domain.Task{}, err
	}
	if active {
		return domain.Task{}, fmt.Errorf("%w: another host operation is already queued or running", domain.ErrConflict)
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
	status, message := ProbeStatus(probe)
	if err = runtime.Stage(ctx, 80, "persist", "Saving detected host capabilities", false); err != nil {
		return nil, err
	}
	err = s.store.UpdateHostProbe(ctx, host.ID, store.HostProbe{HostKey: probe.HostKey, OS: probe.OS, Distro: probe.Distro,
		Architecture: probe.Architecture, DockerVersion: probe.DockerVersion, ComposeVersion: probe.ComposeVersion,
		CPUCount: probe.CPUCount, MemoryBytes: probe.MemoryBytes, DiskTotalBytes: probe.DiskTotalBytes,
		DiskFreeBytes: probe.DiskFreeBytes, DataRootWritable: probe.DataRootWritable,
		PortProbeAvailable: probe.PortProbeAvailable, AvailablePort: probe.FirstAvailablePort,
		Status: status, StatusMessage: message})
	if err != nil {
		return nil, err
	}
	return map[string]any{"hostId": host.ID, "status": status, "fingerprint": probe.HostKey}, nil
}
