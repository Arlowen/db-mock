package instances

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

func boolPointer(value bool) *bool { return &value }

func TestSuccessfulDeleteResultKeepsCleanupEvidence(t *testing.T) {
	instanceID, hostID := uuid.New(), uuid.New()
	result := successfulDeleteResult(domain.Instance{
		ID: instanceID, Name: "orders-cleanup-pg17", HostPort: 20001, BindAddress: "0.0.0.0",
	}, domain.Host{ID: hostID, Name: "QA Hangzhou 01"})

	if result["instanceId"] != instanceID || result["instanceName"] != "orders-cleanup-pg17" ||
		result["hostId"] != hostID || result["hostName"] != "QA Hangzhou 01" ||
		result["releasedHostPort"] != 20001 || result["releasedBindAddress"] != "0.0.0.0" ||
		result["composeProjectRemoved"] != true || result["managedDirectoryRemoved"] != true ||
		result["status"] != "deleted" {
		t.Fatalf("delete result = %#v", result)
	}
}

func TestValidateInstanceAction(t *testing.T) {
	valid := []struct{ status, action string }{
		{status: "stopped", action: "start"},
		{status: "failed", action: "start"},
		{status: "running", action: "stop"},
		{status: "degraded", action: "restart"},
		{status: "failed", action: "delete"},
	}
	for _, test := range valid {
		if err := validateInstanceAction(test.status, test.action); err != nil {
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
		if err := validateInstanceAction(test.status, test.action); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("expected %s for %s to conflict, got %v", test.action, test.status, err)
		}
	}

	for _, action := range []string{"upgrade", "reconfigure", "backup", "restore", "unknown"} {
		if err := validateInstanceAction("running", action); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("expected retired action %q to be invalid, got %v", action, err)
		}
	}
}

func TestBatchActionRejectsUnsafeRequestShapes(t *testing.T) {
	service := &Service{}
	instanceID := uuid.New()
	tests := []struct {
		name        string
		action      string
		instanceIDs []uuid.UUID
	}{
		{name: "unsupported action", action: "delete", instanceIDs: []uuid.UUID{instanceID}},
		{name: "empty selection", action: "start"},
		{name: "duplicate IDs", action: "stop", instanceIDs: []uuid.UUID{instanceID, instanceID}},
		{name: "nil ID", action: "start", instanceIDs: []uuid.UUID{uuid.Nil}},
		{name: "too many IDs", action: "stop", instanceIDs: make([]uuid.UUID, 101)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := service.BatchAction(context.Background(), uuid.New(), test.action, test.instanceIDs); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("BatchAction error = %v, want invalid input", err)
			}
		})
	}
}

func TestValidateBatchInstanceActionKeepsFailedRecoveryIndividual(t *testing.T) {
	for _, test := range []struct{ status, action string }{
		{status: "stopped", action: "start"},
		{status: "running", action: "stop"},
		{status: "degraded", action: "stop"},
		{status: "running", action: "restart"},
		{status: "degraded", action: "restart"},
	} {
		if err := validateBatchInstanceAction(test.status, test.action); err != nil {
			t.Fatalf("expected batch %s for %s to be valid, got %v", test.action, test.status, err)
		}
	}
	for _, test := range []struct{ status, action string }{
		{status: "failed", action: "start"},
		{status: "running", action: "start"},
		{status: "stopped", action: "stop"},
		{status: "provisioning", action: "stop"},
		{status: "stopped", action: "restart"},
		{status: "restarting", action: "restart"},
	} {
		if err := validateBatchInstanceAction(test.status, test.action); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("expected batch %s for %s to conflict, got %v", test.action, test.status, err)
		}
	}
}

func TestBuildCleanupReviewExplainsEveryDeleteBlocker(t *testing.T) {
	instanceID, taskID := uuid.New(), uuid.New()
	expiresAt := time.Date(2026, 7, 25, 12, 0, 0, 0, time.UTC)
	review := buildCleanupReview(domain.Instance{
		ID: instanceID, Name: "orders-db", Status: "running", Purpose: "Release regression",
		Owner: "Payments QA", ExpiresAt: &expiresAt,
	}, []domain.InstanceBackup{{ID: uuid.New()}, {ID: uuid.New()}}, []domain.Task{
		{ID: uuid.New(), Status: "failed"},
		{ID: taskID, Kind: "instance.stop", Status: "queued", Stage: "queued"},
	})
	if review.DeleteReady || review.BackupCount != 2 || review.ActiveTask == nil || review.ActiveTask.ID != taskID ||
		len(review.Blockers) != 2 || review.Blockers[0] != "active_operation" || review.Blockers[1] != "backups_present" {
		t.Fatalf("cleanup review = %#v", review)
	}

	ready := buildCleanupReview(domain.Instance{ID: instanceID, Name: "failed-db", Status: "failed"}, nil, nil)
	if !ready.DeleteReady || len(ready.Blockers) != 0 {
		t.Fatalf("failed instance without managed blockers should be deletable: %#v", ready)
	}
	busy := buildCleanupReview(domain.Instance{ID: instanceID, Name: "busy-db", Status: "backing_up"}, nil, nil)
	if busy.DeleteReady || len(busy.Blockers) != 1 || busy.Blockers[0] != "status_not_deletable" {
		t.Fatalf("busy instance cleanup review = %#v", busy)
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

func TestTaskRestartPoliciesPreserveOldQueuedTaskCompatibility(t *testing.T) {
	instance := domain.Instance{AutoRestart: true}
	target, previous := taskRestartPolicies(ActionPayload{}, instance)
	if !target || !previous {
		t.Fatalf("old payload should preserve the stored policy, got target=%t previous=%t", target, previous)
	}
	target, previous = taskRestartPolicies(ActionPayload{TargetAutoRestart: boolPointer(false),
		PreviousAutoRestart: boolPointer(true)}, instance)
	if target || !previous {
		t.Fatalf("new payload policies = target:%t previous:%t", target, previous)
	}
}

func TestCurrentOrPreviousInstanceStateUsesFreshStableStateOnRetry(t *testing.T) {
	payload := ActionPayload{PreviousStatus: "running", PreviousDesiredState: "running"}
	status, desired := currentOrPreviousInstanceState(payload, domain.Instance{Status: "stopped", DesiredState: "stopped"})
	if status != "stopped" || desired != "stopped" {
		t.Fatalf("stable retry state = %s/%s, want stopped/stopped", status, desired)
	}
	status, desired = currentOrPreviousInstanceState(payload, domain.Instance{Status: "restoring", DesiredState: "running"})
	if status != "running" || desired != "running" {
		t.Fatalf("active operation state = %s/%s, want payload running/running", status, desired)
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

func TestArtifactSupportsVersionRequiresEveryImageAndHostArchitecture(t *testing.T) {
	host := domain.Host{Architecture: "arm64"}
	version := domain.TemplateVersion{ImageReference: "database:17.1", Architectures: []string{"arm64"},
		Manifest: json.RawMessage(`{"imageReferences":["database:17.1","exporter:2"]}`)}
	artifact := domain.ImageArtifact{Status: "ready", Architectures: []string{"amd64", "arm64"}, ImageRefs: []string{"database:17.1", "exporter:2"}}
	if !artifactSupportsVersion(artifact, host, version) {
		t.Fatal("expected matching ready artifact to support the upgrade")
	}
	artifact.Status = "deleting"
	if artifactSupportsVersion(artifact, host, version) {
		t.Fatal("expected deleting artifact to be rejected")
	}
	artifact.Status = "ready"
	artifact.Architectures = []string{"amd64"}
	if artifactSupportsVersion(artifact, host, version) {
		t.Fatal("expected incompatible architecture to be rejected")
	}
	artifact.Architectures = []string{"arm64"}
	artifact.ImageRefs = []string{"database:17.1"}
	if artifactSupportsVersion(artifact, host, version) {
		t.Fatal("expected archive without a required sidecar image reference to be rejected")
	}
}

func TestArtifactDeploymentArchitecturesIntersectsTemplateAndArchive(t *testing.T) {
	version := domain.TemplateVersion{ImageReference: "database:17.1", Architectures: []string{"amd64", "arm64"},
		Manifest: json.RawMessage(`{"imageReferences":["database:17.1","exporter:2"]}`)}
	artifact := domain.ImageArtifact{Status: "ready", Architectures: []string{"arm64"},
		ImageRefs: []string{"database:17.1", "exporter:2"}}
	architectures, err := artifactDeploymentArchitectures(artifact, version)
	if err != nil {
		t.Fatal(err)
	}
	if len(architectures) != 1 || architectures[0] != "arm64" {
		t.Fatalf("deployment architectures = %#v, want [arm64]", architectures)
	}

	artifact.Architectures = []string{"ppc64le"}
	if _, err = artifactDeploymentArchitectures(artifact, version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected disjoint architectures to conflict, got %v", err)
	}
	artifact.Architectures = []string{"arm64"}
	artifact.ImageRefs = []string{"database:17.1"}
	if _, err = artifactDeploymentArchitectures(artifact, version); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected a missing sidecar image to conflict, got %v", err)
	}
}

func TestValidateRegistryTemplateSourceRequiresOneRegistryForEveryImage(t *testing.T) {
	registry := domain.Registry{URL: "https://registry.example.test", Status: "online"}
	matching := domain.TemplateVersion{ImageReference: "registry.example.test/database:1",
		Manifest: json.RawMessage(`{"imageReferences":["registry.example.test/database:1","registry.example.test/exporter:2"]}`)}
	if err := validateRegistryTemplateSource(registry, matching); err != nil {
		t.Fatalf("expected one registry to cover every image: %v", err)
	}
	mixed := matching
	mixed.Manifest = json.RawMessage(`{"imageReferences":["registry.example.test/database:1","ghcr.io/example/exporter:2"]}`)
	if err := validateRegistryTemplateSource(registry, mixed); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected a mixed-registry template to be rejected, got %v", err)
	}
}
