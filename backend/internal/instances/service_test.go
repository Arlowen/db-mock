package instances

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func TestValidateInstanceAction(t *testing.T) {
	versionID := uuid.New()
	valid := []struct {
		status  string
		action  string
		version *uuid.UUID
	}{
		{status: "stopped", action: "start"},
		{status: "failed", action: "start"},
		{status: "running", action: "stop"},
		{status: "degraded", action: "restart"},
		{status: "failed", action: "delete"},
		{status: "stopped", action: "upgrade", version: &versionID},
	}
	for _, test := range valid {
		if err := validateInstanceAction(test.status, test.action, test.version); err != nil {
			t.Fatalf("expected %s for %s to be valid, got %v", test.action, test.status, err)
		}
	}

	conflicts := []struct{ status, action string }{
		{status: "running", action: "start"},
		{status: "stopped", action: "stop"},
		{status: "provisioning", action: "delete"},
		{status: "deleted", action: "restart"},
	}
	for _, test := range conflicts {
		if err := validateInstanceAction(test.status, test.action, nil); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("expected %s for %s to conflict, got %v", test.action, test.status, err)
		}
	}

	if err := validateInstanceAction("running", "upgrade", nil); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected upgrade without a version to be invalid, got %v", err)
	}
	if err := validateInstanceAction("running", "unknown", nil); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected unknown action to be invalid, got %v", err)
	}
}

func TestInstanceActionProgressMessage(t *testing.T) {
	tests := map[string]string{
		"start":   "Starting instance",
		"stop":    "Stopping instance",
		"restart": "Restarting instance",
		"other":   "Updating instance",
	}
	for action, expected := range tests {
		if actual := instanceActionProgressMessage(action); actual != expected {
			t.Fatalf("instanceActionProgressMessage(%q)=%q, want %q", action, actual, expected)
		}
	}
}

func TestInstanceOperationStatus(t *testing.T) {
	tests := map[string]string{
		"start":   "starting",
		"stop":    "stopping",
		"restart": "restarting",
		"delete":  "deleting",
		"upgrade": "upgrading",
	}
	for action, want := range tests {
		if got := instanceOperationStatus(action); got != want {
			t.Errorf("operation status for %s = %q, want %q", action, got, want)
		}
	}
	if got := instanceOperationStatus("unknown"); got != "" {
		t.Fatalf("unknown operation status = %q, want empty", got)
	}
}

func TestInstanceActionFailureState(t *testing.T) {
	tests := []struct {
		action          string
		previousStatus  string
		previousDesired string
		wantStatus      string
		wantDesired     string
	}{
		{action: "start", previousStatus: "stopped", previousDesired: "stopped", wantStatus: "failed", wantDesired: "stopped"},
		{action: "stop", previousStatus: "running", previousDesired: "running", wantStatus: "degraded", wantDesired: "running"},
		{action: "restart", previousStatus: "degraded", previousDesired: "running", wantStatus: "degraded", wantDesired: "running"},
		{action: "delete", previousStatus: "running", previousDesired: "running", wantStatus: "failed", wantDesired: "running"},
	}
	for _, test := range tests {
		t.Run(test.action, func(t *testing.T) {
			got := instanceActionFailureState(test.action, test.previousStatus, test.previousDesired)
			if got.Status != test.wantStatus || got.Desired != test.wantDesired || got.Message == "" {
				t.Fatalf("failure state = %#v, want status=%q desired=%q and a message", got, test.wantStatus, test.wantDesired)
			}
		})
	}
}

func TestUpgradeStableStatePreservesDesiredStop(t *testing.T) {
	tests := []struct {
		previousStatus  string
		previousDesired string
		wantStatus      string
		wantDesired     string
	}{
		{previousStatus: "running", previousDesired: "running", wantStatus: "running", wantDesired: "running"},
		{previousStatus: "degraded", previousDesired: "running", wantStatus: "running", wantDesired: "running"},
		{previousStatus: "stopped", previousDesired: "stopped", wantStatus: "stopped", wantDesired: "stopped"},
	}
	for _, test := range tests {
		got := upgradeStableState(test.previousStatus, test.previousDesired)
		if got.Status != test.wantStatus || got.Desired != test.wantDesired {
			t.Errorf("stable state for %s/%s = %#v, want %s/%s", test.previousStatus, test.previousDesired, got, test.wantStatus, test.wantDesired)
		}
	}
}

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

func TestPortAvailableHonorsPoolAndReservations(t *testing.T) {
	host := domain.Host{PortStart: 20000, PortEnd: 20002}
	reservation := store.HostReservation{Ports: map[int]struct{}{20001: {}}}

	if !portAvailable(host, reservation, 0) {
		t.Fatal("expected automatic port allocation to remain eligible")
	}
	if !portAvailable(host, reservation, 20002) {
		t.Fatal("expected unused port in the host pool to be eligible")
	}
	if portAvailable(host, reservation, 20001) {
		t.Fatal("expected a reserved port to be rejected")
	}
	if portAvailable(host, reservation, 19999) {
		t.Fatal("expected a port outside the host pool to be rejected")
	}
	reservation.Ports[20000] = struct{}{}
	reservation.Ports[20002] = struct{}{}
	if portAvailable(host, reservation, 0) {
		t.Fatal("expected automatic allocation to reject a fully reserved pool")
	}
}

func TestChooseAvailablePortSkipsReservationsAndRealListeners(t *testing.T) {
	host := domain.Host{PortStart: 20000, PortEnd: 20003}
	reservation := store.HostReservation{Ports: map[int]struct{}{20000: {}}}
	listening := map[int]struct{}{20001: {}, 20003: {}}

	if got, ok := chooseAvailablePort(host, reservation, listening, 0); !ok || got != 20002 {
		t.Fatalf("automatic port = %d, %v; want 20002, true", got, ok)
	}
	if _, ok := chooseAvailablePort(host, reservation, listening, 20001); ok {
		t.Fatal("expected a listening requested port to be rejected")
	}
	if got, ok := chooseAvailablePort(host, reservation, listening, 20002); !ok || got != 20002 {
		t.Fatalf("requested port = %d, %v; want 20002, true", got, ok)
	}
	listening[20002] = struct{}{}
	if _, ok := chooseAvailablePort(host, reservation, listening, 0); ok {
		t.Fatal("expected a pool without a free real TCP port to be rejected")
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
