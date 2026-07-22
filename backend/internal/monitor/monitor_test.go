package monitor

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/hostops"
	platformsettings "github.com/pika/db-mock/internal/settings"
)

func TestHostProbeFailureSeparatesCredentialRejection(t *testing.T) {
	if got := hostProbeAlertType(fmt.Errorf("wrapped: %w", hostops.ErrSSHCredentialInvalid)); got != "ssh_credential_invalid" {
		t.Fatalf("credential failure alert type = %q", got)
	}
	if got := hostProbeAlertType(errors.New("connection refused")); got != "host_offline" {
		t.Fatalf("network failure alert type = %q", got)
	}
}

func TestDiskAlertTypeHonorsThresholdsAndSwitches(t *testing.T) {
	active := platformsettings.DefaultMonitoringPolicy(30, 7)
	if got := diskAlertType(active, 95); got != platformsettings.AlertDiskCritical {
		t.Fatalf("critical disk alert = %q", got)
	}
	active.Alerts.DiskCritical = false
	if got := diskAlertType(active, 95); got != platformsettings.AlertDiskWarning {
		t.Fatalf("disabled critical alert should fall back to warning, got %q", got)
	}
	active.Alerts.DiskWarning = false
	if got := diskAlertType(active, 95); got != "" {
		t.Fatalf("disabled disk alerts should suppress alert, got %q", got)
	}
}

func TestAggregateInstanceMetricsIncludesBackingFilesystemUsage(t *testing.T) {
	hostID := uuid.New()
	instanceID := uuid.New()
	collectedAt := time.Date(2026, 7, 22, 12, 30, 0, 0, time.UTC)
	result := aggregateInstanceMetrics(hostID, []hostops.ContainerMetric{
		{InstanceID: instanceID.String(), CPUPercent: 4.5, MemoryBytes: 1024, MemoryPercent: 2.5},
		{InstanceID: instanceID.String(), CPUPercent: 5.5, MemoryBytes: 2048, MemoryPercent: 3.5},
		{InstanceID: "not-an-instance-id", CPUPercent: 100},
	}, 30*1024, 100*1024, collectedAt)

	if len(result) != 1 {
		t.Fatalf("aggregated metrics = %#v", result)
	}
	metric := result[instanceID]
	if metric.HostID != hostID || metric.InstanceID == nil || *metric.InstanceID != instanceID {
		t.Fatalf("metric identity = %#v", metric)
	}
	if metric.CPUPercent != 10 || metric.MemoryBytes != 3072 || metric.MemoryPercent != 6 {
		t.Fatalf("container totals = %#v", metric)
	}
	if metric.DiskUsedBytes != 30*1024 || metric.DiskTotalBytes != 100*1024 || !metric.CollectedAt.Equal(collectedAt) {
		t.Fatalf("backing filesystem metric = %#v", metric)
	}
}

func TestTaskOwnedInstanceStatesAreNotOverwrittenByMonitoring(t *testing.T) {
	for _, status := range []string{"provisioning", "starting", "stopping", "restarting", "upgrading", "reconfiguring", "backing_up", "restoring", "deleting", "failed"} {
		if !taskOwnsInstanceState(status) {
			t.Fatalf("expected %q to remain owned by its task", status)
		}
	}
	for _, status := range []string{"running", "stopped", "degraded"} {
		if taskOwnsInstanceState(status) {
			t.Fatalf("expected monitoring to reconcile %q", status)
		}
	}
}

func TestDecideInstanceReconciliation(t *testing.T) {
	tests := []struct {
		name        string
		desired     string
		observed    hostops.ManagedState
		wantStatus  string
		wantMessage string
		wantFailure string
	}{
		{name: "healthy", desired: "running", observed: hostops.ManagedState{State: "running", Health: "healthy"}, wantStatus: "running"},
		{name: "no healthcheck", desired: "running", observed: hostops.ManagedState{State: "running"}, wantStatus: "running"},
		{name: "health starting", desired: "running", observed: hostops.ManagedState{State: "running", Health: "starting"}, wantStatus: "degraded", wantMessage: "Container health check is starting"},
		{name: "health failed", desired: "running", observed: hostops.ManagedState{State: "running", Health: "unhealthy"}, wantStatus: "degraded", wantMessage: "Container health check is failing", wantFailure: "container_unhealthy"},
		{name: "unknown health is failure", desired: "running", observed: hostops.ManagedState{State: "running", Health: "unknown"}, wantStatus: "degraded", wantMessage: "Container health check is failing", wantFailure: "container_unhealthy"},
		{name: "some containers exited", desired: "running", observed: hostops.ManagedState{State: "degraded", Health: "unhealthy"}, wantStatus: "degraded", wantMessage: "One or more database containers are not running", wantFailure: "container_exited"},
		{name: "all containers stopped", desired: "running", observed: hostops.ManagedState{State: "stopped"}, wantStatus: "degraded", wantMessage: "Container is not running", wantFailure: "container_exited"},
		{name: "missing containers", desired: "running", observed: hostops.ManagedState{}, wantStatus: "degraded", wantMessage: "Container is not running", wantFailure: "container_exited"},
		{name: "desired stop reached", desired: "stopped", observed: hostops.ManagedState{State: "stopped"}, wantStatus: "stopped"},
		{name: "desired stop not reached", desired: "stopped", observed: hostops.ManagedState{State: "running", Health: "healthy"}, wantStatus: "degraded", wantMessage: "Container is running while desired state is stopped"},
		{name: "desired stop partially reached", desired: "stopped", observed: hostops.ManagedState{State: "degraded"}, wantStatus: "degraded", wantMessage: "Container is running while desired state is stopped"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := decideInstanceReconciliation(test.desired, test.observed)
			if got.Status != test.wantStatus || got.Message != test.wantMessage || got.Failure != test.wantFailure {
				t.Fatalf("decision = %#v, want status=%q message=%q failure=%q", got, test.wantStatus, test.wantMessage, test.wantFailure)
			}
		})
	}
}

func TestWebhookEventForRuntimeAlerts(t *testing.T) {
	for alertType, want := range map[string]string{
		"container_exited":       "instance.failed",
		"container_unhealthy":    "instance.failed",
		"restart_failed":         "instance.restart_failed",
		"upgrade_failed":         "instance.failed",
		"ssh_credential_invalid": "host.offline",
	} {
		if got := webhookEventForAlert(alertType); got != want {
			t.Errorf("event for %s = %q, want %q", alertType, got, want)
		}
	}
}
