package instances

import (
	"testing"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestFitsHostHonorsDeploymentHeadroom(t *testing.T) {
	host := domain.Host{CPUCount: 10, MemoryBytes: 1000, DiskFreeBytes: 1000}
	reservation := store.HostReservation{CPU: 4, Memory: 300, Disk: 300}

	if !fitsHost(host, reservation, 5, 500, 500) {
		t.Fatal("expected request at the deployment thresholds to fit")
	}
	if fitsHost(host, reservation, 5.01, 500, 500) {
		t.Fatal("expected CPU request above the 90 percent threshold to be rejected")
	}
	if fitsHost(host, reservation, 5, 501, 500) {
		t.Fatal("expected memory request above the 80 percent threshold to be rejected")
	}
	if fitsHost(host, reservation, 5, 500, 501) {
		t.Fatal("expected disk request above the 80 percent threshold to be rejected")
	}
}

func TestContainsRequiresExactImageReference(t *testing.T) {
	refs := []string{"postgres:17", "registry.example.com/team/postgres:17"}
	if !contains(refs, "postgres:17") {
		t.Fatal("expected exact image reference to match")
	}
	if contains(refs, "postgres:latest") {
		t.Fatal("expected a different image tag to be rejected")
	}
}
