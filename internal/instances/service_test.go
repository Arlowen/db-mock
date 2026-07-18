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

func TestImageRegistryHost(t *testing.T) {
	tests := map[string]string{
		"postgres:17":                        "docker.io",
		"library/postgres:17":                "docker.io",
		"ghcr.io/example/postgres:17":        "ghcr.io",
		"localhost:5000/example/postgres:17": "localhost:5000",
		"registry-1.docker.io/postgres:17":   "docker.io",
	}
	for reference, expected := range tests {
		if got := imageRegistryHost(reference); got != expected {
			t.Fatalf("imageRegistryHost(%q)=%q, want %q", reference, got, expected)
		}
	}
}

func TestValidateRegistryImageSource(t *testing.T) {
	matching := domain.Registry{URL: "https://ghcr.io", Status: "online"}
	if err := validateRegistryImageSource(matching, "ghcr.io/example/postgres:17"); err != nil {
		t.Fatal(err)
	}
	for _, registry := range []domain.Registry{
		{URL: "https://harbor.example.com", Status: "online"},
		{URL: "https://ghcr.io", Status: "degraded"},
	} {
		if err := validateRegistryImageSource(registry, "ghcr.io/example/postgres:17"); err == nil {
			t.Fatalf("expected registry %#v to be rejected", registry)
		}
	}
}
