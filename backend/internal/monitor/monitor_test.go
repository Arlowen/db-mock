package monitor

import (
	"testing"

	"github.com/pika/db-mock/internal/hostops"
)

func TestDecideInstanceReconciliationKeepsRuntimeStatusActionable(t *testing.T) {
	tests := []struct {
		name     string
		desired  string
		observed hostops.ManagedState
		status   string
		failure  string
	}{
		{name: "healthy", desired: "running", observed: hostops.ManagedState{State: "running", Health: "healthy"}, status: "running"},
		{name: "health starting", desired: "running", observed: hostops.ManagedState{State: "running", Health: "starting"}, status: "degraded"},
		{name: "unhealthy", desired: "running", observed: hostops.ManagedState{State: "running", Health: "unhealthy"}, status: "degraded", failure: "container_unhealthy"},
		{name: "container exited", desired: "running", observed: hostops.ManagedState{State: "stopped"}, status: "degraded", failure: "container_exited"},
		{name: "expected stop", desired: "stopped", observed: hostops.ManagedState{State: "stopped"}, status: "stopped"},
		{name: "unexpected running", desired: "stopped", observed: hostops.ManagedState{State: "running"}, status: "degraded"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := decideInstanceReconciliation(test.desired, test.observed)
			if got.Status != test.status || got.Failure != test.failure {
				t.Fatalf("reconciliation = %#v, want status=%s failure=%s", got, test.status, test.failure)
			}
			if got.Status == "degraded" && got.Message == "" {
				t.Fatalf("degraded state has no diagnostic message: %#v", got)
			}
		})
	}
}

func TestTaskOwnedStatusesAreNotOverwrittenByReconciliation(t *testing.T) {
	for _, status := range []string{"provisioning", "starting", "stopping", "restarting", "failed", "deleting"} {
		if !taskOwnsInstanceState(status) {
			t.Fatalf("task-owned status %q was not protected", status)
		}
	}
	for _, status := range []string{"running", "stopped", "degraded"} {
		if taskOwnsInstanceState(status) {
			t.Fatalf("stable status %q should be reconciled", status)
		}
	}
}
