package monitor

import "testing"

func TestTaskOwnedInstanceStatesAreNotOverwrittenByMonitoring(t *testing.T) {
	for _, status := range []string{"provisioning", "upgrading", "deleting", "failed"} {
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
