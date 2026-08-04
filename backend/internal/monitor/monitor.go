package monitor

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/store"
)

// Monitor is the MVP state reconciler. It keeps host capabilities and database runtime status
// current, but intentionally does not retain metrics, create alerts, or emit webhooks.
type Monitor struct {
	store     *store.Store
	docker    *hostops.Docker
	logger    *slog.Logger
	interval  time.Duration
	semaphore chan struct{}
}

func New(target *store.Store, docker *hostops.Docker, logger *slog.Logger, interval time.Duration) *Monitor {
	return &Monitor{store: target, docker: docker, logger: logger, interval: interval, semaphore: make(chan struct{}, 4)}
}

func (m *Monitor) Start(ctx context.Context) { go m.loop(ctx) }

func (m *Monitor) loop(ctx context.Context) {
	cleanup := time.NewTicker(time.Hour)
	defer cleanup.Stop()
	for {
		m.run(ctx)
		timer := time.NewTimer(m.interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-cleanup.C:
			timer.Stop()
			_, _ = m.store.CleanupSessions(ctx)
		}
	}
}

func (m *Monitor) run(ctx context.Context) {
	hosts, err := m.store.ListHosts(ctx)
	if err != nil {
		m.logger.Error("list hosts for state reconciliation", "error", err)
		return
	}
	var wg sync.WaitGroup
	for _, host := range hosts {
		host := host
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case m.semaphore <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-m.semaphore }()
			m.checkHost(ctx, host)
		}()
	}
	wg.Wait()
}

func (m *Monitor) checkHost(ctx context.Context, host domain.Host) {
	probe, err := m.docker.Probe(ctx, host)
	if err != nil {
		message := err.Error()
		if hostops.IsSSHCredentialInvalid(err) {
			message = "SSH credential was rejected"
		}
		_ = m.store.SetHostStatus(ctx, host.ID, "offline", message, false)
		return
	}
	status, message := hostops.ProbeStatus(probe)
	_ = m.store.UpdateHostProbe(ctx, host.ID, store.HostProbe{
		HostKey: probe.HostKey, OS: probe.OS, Distro: probe.Distro, Architecture: probe.Architecture,
		DockerVersion: probe.DockerVersion, ComposeVersion: probe.ComposeVersion, CPUCount: probe.CPUCount,
		MemoryBytes: probe.MemoryBytes, DiskTotalBytes: probe.DiskTotalBytes, DiskFreeBytes: probe.DiskFreeBytes,
		DataRootWritable: probe.DataRootWritable, PortProbeAvailable: probe.PortProbeAvailable,
		AvailablePort: probe.FirstAvailablePort, Status: status, StatusMessage: message,
	})
	if status != "online" {
		return
	}
	states, err := m.docker.ManagedStates(ctx, host)
	if err != nil {
		m.logger.Warn("read managed database states", "hostId", host.ID, "error", err)
		return
	}
	instances, err := m.store.ListInstances(ctx, &host.ID, "")
	if err != nil {
		m.logger.Warn("list databases for state reconciliation", "hostId", host.ID, "error", err)
		return
	}
	for _, instance := range instances {
		m.reconcileInstance(ctx, host, instance, states[instance.ID.String()])
	}
}

type instanceReconciliation struct {
	Status  string
	Message string
	Failure string
}

func decideInstanceReconciliation(desired string, observed hostops.ManagedState) instanceReconciliation {
	if desired == "stopped" {
		if observed.State == "stopped" || observed.State == "" {
			return instanceReconciliation{Status: "stopped"}
		}
		return instanceReconciliation{Status: "degraded", Message: "Container is running while desired state is stopped"}
	}
	if observed.State == "running" {
		switch observed.Health {
		case "", "healthy":
			return instanceReconciliation{Status: "running"}
		case "starting":
			return instanceReconciliation{Status: "degraded", Message: "Container health check is starting"}
		default:
			return instanceReconciliation{Status: "degraded", Message: "Container health check is failing", Failure: "container_unhealthy"}
		}
	}
	if observed.State == "degraded" {
		return instanceReconciliation{Status: "degraded", Message: "One or more database containers are not running", Failure: "container_exited"}
	}
	return instanceReconciliation{Status: "degraded", Message: "Container is not running", Failure: "container_exited"}
}

func (m *Monitor) reconcileInstance(ctx context.Context, host domain.Host, instance domain.Instance, observed hostops.ManagedState) {
	if taskOwnsInstanceState(instance.Status) {
		return
	}
	decision := decideInstanceReconciliation(instance.DesiredState, observed)
	_ = m.store.UpdateInstanceState(ctx, instance.ID, decision.Status, instance.DesiredState, decision.Message)
	if decision.Failure == "" || instance.DesiredState == "stopped" || !instance.AutoRestart || instance.RestartFailures >= 3 {
		return
	}
	count, err := m.store.IncrementRestartFailure(ctx, instance.ID)
	if err != nil {
		m.logger.Warn("record automatic restart attempt", "instanceId", instance.ID, "error", err)
		return
	}
	restartCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	err = m.docker.ComposeStart(restartCtx, host, instance)
	cancel()
	if err != nil {
		m.logger.Warn("automatic database restart failed", "instanceId", instance.ID, "attempt", count, "error", err)
		if count >= 3 {
			_ = m.store.UpdateInstanceState(ctx, instance.ID, "degraded", instance.DesiredState,
				"Automatic restart failed; inspect recent logs and retry manually")
		}
	}
}

func taskOwnsInstanceState(status string) bool {
	switch status {
	case "provisioning", "starting", "stopping", "restarting", "upgrading", "reconfiguring", "backing_up", "restoring", "deleting", "failed":
		return true
	default:
		return false
	}
}
