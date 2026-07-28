package domain

import (
	"slices"
	"testing"
)

func TestInstanceCleanupBlockersMatchDeletePolicy(t *testing.T) {
	tests := []struct {
		name       string
		status     string
		backups    int
		activeTask bool
		want       []string
	}{
		{name: "ready stopped instance", status: "stopped", want: []string{}},
		{name: "all blockers", status: "provisioning", backups: 2, activeTask: true,
			want: []string{CleanupBlockerActiveOperation, CleanupBlockerBackupsPresent, CleanupBlockerStatusNotDeletable}},
		{name: "failed instance remains deletable", status: "failed", backups: 1,
			want: []string{CleanupBlockerBackupsPresent}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := InstanceCleanupBlockers(test.status, test.backups, test.activeTask)
			if !slices.Equal(got, test.want) {
				t.Fatalf("InstanceCleanupBlockers() = %#v, want %#v", got, test.want)
			}
		})
	}
}
