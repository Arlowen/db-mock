package monitor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	"github.com/pika/db-mock/internal/store"
)

type Monitor struct {
	store     *store.Store
	docker    *hostops.Docker
	logger    *slog.Logger
	interval  time.Duration
	retention time.Duration
	semaphore chan struct{}
}

type policy struct {
	IntervalSeconds     int     `json:"intervalSeconds"`
	RetentionDays       int     `json:"retentionDays"`
	DiskWarningPercent  float64 `json:"diskWarningPercent"`
	DiskCriticalPercent float64 `json:"diskCriticalPercent"`
}

func New(target *store.Store, docker *hostops.Docker, logger *slog.Logger, interval, retention time.Duration) *Monitor {
	return &Monitor{store: target, docker: docker, logger: logger, interval: interval, retention: retention, semaphore: make(chan struct{}, 4)}
}

func (m *Monitor) Start(ctx context.Context) { go m.loop(ctx) }

func (m *Monitor) loop(ctx context.Context) {
	cleanup := time.NewTicker(time.Hour)
	defer cleanup.Stop()
	for {
		active := m.loadPolicy(ctx)
		m.run(ctx, active)
		timer := time.NewTimer(time.Duration(active.IntervalSeconds) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		case <-cleanup.C:
			timer.Stop()
			_, _ = m.store.DeleteOldMetrics(ctx, time.Now().Add(-time.Duration(active.RetentionDays)*24*time.Hour))
			_, _ = m.store.CleanupSessions(ctx)
		}
	}
}

func (m *Monitor) loadPolicy(ctx context.Context) policy {
	result := policy{IntervalSeconds: max(int(m.interval/time.Second), 5), RetentionDays: max(int(m.retention/(24*time.Hour)), 1), DiskWarningPercent: 80, DiskCriticalPercent: 90}
	settings, err := m.store.GetSettings(ctx)
	if err != nil {
		return result
	}
	if raw := settings["monitoring"]; len(raw) > 0 {
		var configured policy
		if json.Unmarshal(raw, &configured) == nil {
			if configured.IntervalSeconds >= 5 && configured.IntervalSeconds <= 3600 {
				result.IntervalSeconds = configured.IntervalSeconds
			}
			if configured.RetentionDays >= 1 && configured.RetentionDays <= 365 {
				result.RetentionDays = configured.RetentionDays
			}
			if configured.DiskWarningPercent >= 1 && configured.DiskWarningPercent < 100 {
				result.DiskWarningPercent = configured.DiskWarningPercent
			}
			if configured.DiskCriticalPercent > result.DiskWarningPercent && configured.DiskCriticalPercent <= 100 {
				result.DiskCriticalPercent = configured.DiskCriticalPercent
			}
		}
	}
	return result
}

func (m *Monitor) run(ctx context.Context, active policy) {
	hosts, err := m.store.ListHosts(ctx)
	if err != nil {
		m.logger.Error("list hosts for monitoring", "error", err)
		return
	}
	var wg sync.WaitGroup
	for _, host := range hosts {
		if host.Maintenance {
			continue
		}
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
			m.checkHost(ctx, host, active)
		}()
	}
	wg.Wait()
}

func (m *Monitor) checkHost(ctx context.Context, host domain.Host, active policy) {
	probe, err := m.docker.Probe(ctx, host)
	if err != nil {
		_ = m.store.SetHostStatus(ctx, host.ID, "offline", err.Error(), false)
		fresh, _ := m.store.GetHost(ctx, host.ID)
		if fresh.ConsecutiveFailures >= 3 {
			m.raise(ctx, store.AlertInput{Severity: "critical", Type: "host_offline", ResourceType: "host", ResourceID: host.ID, Title: "Host is offline", Message: err.Error()})
		}
		return
	}
	status := "online"
	message := ""
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		status = "needs_docker"
		message = hostops.DockerUnavailableMessage
	}
	_ = m.store.UpdateHostProbe(ctx, host.ID, store.HostProbe{HostKey: probe.HostKey, OS: probe.OS, Distro: probe.Distro, Architecture: probe.Architecture,
		DockerVersion: probe.DockerVersion, ComposeVersion: probe.ComposeVersion, CPUCount: probe.CPUCount, MemoryBytes: probe.MemoryBytes,
		DiskTotalBytes: probe.DiskTotalBytes, DiskFreeBytes: probe.DiskFreeBytes, Status: status, StatusMessage: message})
	_ = m.store.ResolveAlerts(ctx, "host", host.ID, "host_offline")
	if status != "online" {
		return
	}
	metrics, diskUsed, diskTotal, err := m.docker.Metrics(ctx, host)
	if err != nil {
		m.logger.Warn("collect host metrics", "hostId", host.ID, "error", err)
		return
	}
	now := time.Now()
	_ = m.store.AddMetric(ctx, domain.MetricSample{HostID: host.ID, DiskUsedBytes: diskUsed, DiskTotalBytes: diskTotal, CollectedAt: now})
	if diskTotal > 0 {
		percent := float64(diskUsed) * 100 / float64(diskTotal)
		if percent >= active.DiskCriticalPercent {
			m.raise(ctx, store.AlertInput{Severity: "critical", Type: "disk_critical", ResourceType: "host", ResourceID: host.ID, Title: "Disk usage is critical", Message: fmt.Sprintf("Disk usage is %.1f%%", percent)})
		} else if percent >= active.DiskWarningPercent {
			m.raise(ctx, store.AlertInput{Severity: "warning", Type: "disk_warning", ResourceType: "host", ResourceID: host.ID, Title: "Disk usage is high", Message: fmt.Sprintf("Disk usage is %.1f%%", percent)})
		} else {
			_ = m.store.ResolveAlerts(ctx, "host", host.ID, "disk_warning")
			_ = m.store.ResolveAlerts(ctx, "host", host.ID, "disk_critical")
		}
	}
	aggregated := make(map[uuid.UUID]domain.MetricSample)
	for _, metric := range metrics {
		id, parseErr := uuid.Parse(metric.InstanceID)
		if parseErr != nil {
			continue
		}
		item := aggregated[id]
		item.HostID = host.ID
		item.InstanceID = &id
		item.CPUPercent += metric.CPUPercent
		item.MemoryBytes += metric.MemoryBytes
		item.MemoryPercent += metric.MemoryPercent
		item.CollectedAt = now
		aggregated[id] = item
	}
	for _, metric := range aggregated {
		_ = m.store.AddMetric(ctx, metric)
	}
	states, err := m.docker.ManagedStates(ctx, host)
	if err != nil {
		return
	}
	instances, err := m.store.ListInstances(ctx, &host.ID, nil, "")
	if err != nil {
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
	if instance.DesiredState == "stopped" {
		m.resolveRuntimeAlerts(ctx, instance.ID, "container_exited", "container_unhealthy", "restart_failed")
		return
	}
	switch decision.Failure {
	case "":
		_ = m.store.ResolveAlerts(ctx, "instance", instance.ID, "container_exited")
		if decision.Status == "running" {
			m.resolveRuntimeAlerts(ctx, instance.ID, "container_unhealthy", "restart_failed")
		}
		return
	case "container_unhealthy":
		_ = m.store.ResolveAlerts(ctx, "instance", instance.ID, "container_exited")
		m.raise(ctx, store.AlertInput{Severity: "warning", Type: "container_unhealthy", ResourceType: "instance", ResourceID: instance.ID,
			Title: "Database health check failed", Message: "Docker reported that the database health check is " + observed.Health,
			Details: map[string]string{"healthStatus": observed.Health}})
		return
	}
	_ = m.store.ResolveAlerts(ctx, "instance", instance.ID, "container_unhealthy")
	m.raise(ctx, store.AlertInput{Severity: "warning", Type: "container_exited", ResourceType: "instance", ResourceID: instance.ID,
		Title: "Database container stopped", Message: "One or more database containers exited unexpectedly",
		Details: map[string]string{"containerState": observed.State, "healthStatus": observed.Health}})
	if !instance.AutoRestart || instance.RestartFailures >= 3 {
		return
	}
	count, _ := m.store.IncrementRestartFailure(ctx, instance.ID)
	restartCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	err := m.docker.ComposeStart(restartCtx, host, instance)
	cancel()
	if err != nil && count >= 3 {
		m.raise(ctx, store.AlertInput{Severity: "critical", Type: "restart_failed", ResourceType: "instance", ResourceID: instance.ID, Title: "Automatic restart failed", Message: err.Error()})
	}
}

func (m *Monitor) resolveRuntimeAlerts(ctx context.Context, instanceID uuid.UUID, alertTypes ...string) {
	for _, alertType := range alertTypes {
		_ = m.store.ResolveAlerts(ctx, "instance", instanceID, alertType)
	}
}

func taskOwnsInstanceState(status string) bool {
	switch status {
	case "provisioning", "starting", "stopping", "restarting", "upgrading", "deleting", "failed":
		return true
	default:
		return false
	}
}

func (m *Monitor) raise(ctx context.Context, input store.AlertInput) {
	alert, created, err := m.store.CreateAlert(ctx, input)
	if err != nil {
		m.logger.Error("create alert", "error", err)
		return
	}
	if created {
		_ = m.store.EnqueueWebhookEvent(ctx, "alert.created", alert)
		if eventType := webhookEventForAlert(input.Type); eventType != "" {
			_ = m.store.EnqueueWebhookEvent(ctx, eventType, alert)
		}
	}
}

func webhookEventForAlert(alertType string) string {
	eventTypes := map[string]string{
		"host_offline":        "host.offline",
		"container_exited":    "instance.failed",
		"container_unhealthy": "instance.failed",
		"upgrade_failed":      "instance.failed",
		"restart_failed":      "instance.restart_failed",
		"disk_warning":        "host.disk_warning",
		"disk_critical":       "host.disk_critical",
	}
	return eventTypes[alertType]
}
