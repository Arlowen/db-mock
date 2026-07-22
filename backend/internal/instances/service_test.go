package instances

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/templates"
)

func boolPointer(value bool) *bool { return &value }

func TestRollbackOperationUsesStableRetryLineage(t *testing.T) {
	taskID, operationID := uuid.New(), uuid.New()
	got, reuse := rollbackOperation(ActionPayload{}, domain.Task{ID: taskID})
	if got != taskID || reuse {
		t.Fatalf("initial operation = %s, reuse=%v", got, reuse)
	}
	got, reuse = rollbackOperation(ActionPayload{OperationID: &operationID, ReuseRollbackSnapshot: true}, domain.Task{ID: taskID})
	if got != operationID || !reuse {
		t.Fatalf("retried operation = %s, reuse=%v", got, reuse)
	}
}

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
		{status: "running", action: "reconfigure"},
		{status: "degraded", action: "reconfigure"},
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
		{status: "failed", action: "reconfigure"},
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

func TestValidateInstanceActionRequestRejectsCrossActionFields(t *testing.T) {
	versionID := uuid.New()
	for name, test := range map[string]struct {
		action  string
		request ActionRequest
	}{
		"upgrade fields on start":     {action: "start", request: ActionRequest{NewTemplateVersionID: &versionID}},
		"image fields on reconfigure": {action: "reconfigure", request: ActionRequest{ImageSource: "public"}},
		"runtime fields on upgrade":   {action: "upgrade", request: ActionRequest{CPU: 2}},
		"restart policy on upgrade":   {action: "upgrade", request: ActionRequest{AutoRestart: boolPointer(true)}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateInstanceActionRequest(test.action, test.request); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("expected cross-action fields to be invalid, got %v", err)
			}
		})
	}
	if err := validateInstanceActionRequest("upgrade", ActionRequest{NewTemplateVersionID: &versionID, ImageSource: "public"}); err != nil {
		t.Fatalf("expected upgrade fields to be valid: %v", err)
	}
	if err := validateInstanceActionRequest("reconfigure", ActionRequest{CPU: 2, MemoryBytes: 1024, DiskBytes: 2048, ExtraEnvironment: map[string]string{}, AutoRestart: boolPointer(true)}); err != nil {
		t.Fatalf("expected runtime fields to be valid: %v", err)
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
		"start":       "starting",
		"stop":        "stopping",
		"restart":     "restarting",
		"delete":      "deleting",
		"upgrade":     "upgrading",
		"reconfigure": "reconfiguring",
		"backup":      "backing_up",
		"restore":     "restoring",
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

func TestPrepareRuntimeConfigurationPreservesImageSelection(t *testing.T) {
	artifactID, registryID := uuid.New(), uuid.New()
	instance := domain.Instance{
		ID: uuid.New(), CPU: 1, MemoryBytes: 1024, ReservedDiskBytes: 2048,
		HostPort: 5432, BindAddress: "0.0.0.0", RemoteDirectory: "/opt/dbmock/instances/test",
		Configuration: json.RawMessage(`{"extraEnvironment":{"TZ":"UTC"},"imageArtifactId":"` + artifactID.String() + `","registryId":"` + registryID.String() + `"}`),
	}
	template := domain.Template{Slug: "postgres"}
	version := domain.TemplateVersion{MinCPU: 1, MinMemoryBytes: 1024, MinDiskBytes: 2048,
		ImageReference: "postgres:17", ComposeTemplate: "services:\n  database:\n    image: {{ .Image }}\n    cpus: {{ .CPU }}\n    mem_limit: {{ .MemoryBytes }}\n    environment:\n{{ .ExtraEnvironment }}"}
	target, raw, err := prepareRuntimeConfiguration(template, version, instance, ActionRequest{
		CPU: 2, MemoryBytes: 4096, DiskBytes: 8192, ExtraEnvironment: map[string]string{"TZ": "Asia/Shanghai"},
		AutoRestart: boolPointer(true),
	})
	if err != nil {
		t.Fatal(err)
	}
	if target.CPU != 2 || target.MemoryBytes != 4096 || target.ReservedDiskBytes != 8192 || !target.AutoRestart {
		t.Fatalf("unexpected target resources: %#v", target)
	}
	var configuration instanceConfiguration
	if err = json.Unmarshal(raw, &configuration); err != nil {
		t.Fatal(err)
	}
	if configuration.ImageArtifactID == nil || *configuration.ImageArtifactID != artifactID ||
		configuration.RegistryID == nil || *configuration.RegistryID != registryID {
		t.Fatalf("image selection was not preserved: %#v", configuration)
	}
	if configuration.ExtraEnvironment["TZ"] != "Asia/Shanghai" {
		t.Fatalf("environment was not updated: %#v", configuration.ExtraEnvironment)
	}
}

func TestTemplateParametersPersistAcrossReconfigureAndConvergeOnUpgrade(t *testing.T) {
	manifest, err := json.Marshal(templates.Manifest{Parameters: []templates.TemplateParameter{
		{Key: "mode", Type: "select", Environment: "DB_MODE", Label: "Mode", Required: true,
			Default: "safe", Options: []templates.TemplateParameterOption{{Value: "safe"}, {Value: "fast"}}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	version := domain.TemplateVersion{Manifest: manifest, MinCPU: 1, MinMemoryBytes: 1024, MinDiskBytes: 2048,
		ImageReference: "database:1", ComposeTemplate: "services:\n  database:\n    image: {{ .Image }}\n    environment:\n{{ .ExtraEnvironment }}"}
	instance := domain.Instance{ID: uuid.New(), CPU: 1, MemoryBytes: 1024, ReservedDiskBytes: 2048,
		HostPort: 5432, BindAddress: "0.0.0.0", RemoteDirectory: "/opt/dbmock/instances/test",
		Configuration: json.RawMessage(`{"extraEnvironment":{"LANG":"C.UTF-8"},"templateParameters":{"mode":"fast"}}`)}

	target, raw, err := prepareRuntimeConfiguration(domain.Template{Slug: "custom"}, version, instance, ActionRequest{
		CPU: 2, MemoryBytes: 2048, DiskBytes: 4096, ExtraEnvironment: map[string]string{"LANG": "en_US.UTF-8"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var configuration instanceConfiguration
	if err = json.Unmarshal(raw, &configuration); err != nil {
		t.Fatal(err)
	}
	if target.CPU != 2 || configuration.TemplateParameters["mode"] != "fast" || configuration.ExtraEnvironment["LANG"] != "en_US.UTF-8" {
		t.Fatalf("reconfigured template values = target:%#v configuration:%#v", target, configuration)
	}
	_, environment, err := resolveTemplateEnvironment(version, configuration, true)
	if err != nil || environment["DB_MODE"] != "fast" || environment["LANG"] != "en_US.UTF-8" {
		t.Fatalf("rendered environment = %#v, %v", environment, err)
	}

	targetManifest, _ := json.Marshal(templates.Manifest{Parameters: []templates.TemplateParameter{
		{Key: "cache", Type: "boolean", Environment: "CACHE_ENABLED", Label: "Cache", Default: true},
	}})
	upgraded, environment, err := resolveTemplateEnvironment(domain.TemplateVersion{Manifest: targetManifest}, configuration, false)
	if err != nil || len(upgraded.TemplateParameters) != 1 || upgraded.TemplateParameters["cache"] != true || environment["CACHE_ENABLED"] != "true" {
		t.Fatalf("upgraded template values = configuration:%#v environment:%#v err:%v", upgraded, environment, err)
	}
	if _, exists := upgraded.TemplateParameters["mode"]; exists {
		t.Fatalf("a parameter removed by the target version survived: %#v", upgraded.TemplateParameters)
	}
}

func TestPrepareRuntimeConfigurationRejectsUnsafeOrEmptyChanges(t *testing.T) {
	instance := domain.Instance{ID: uuid.New(), CPU: 1, MemoryBytes: 1024, ReservedDiskBytes: 2048,
		HostPort: 5432, BindAddress: "0.0.0.0", RemoteDirectory: "/opt/dbmock/instances/test",
		Configuration: json.RawMessage(`{"extraEnvironment":{"TZ":"UTC"}}`)}
	template := domain.Template{Slug: "postgres"}
	version := domain.TemplateVersion{MinCPU: 1, MinMemoryBytes: 1024, MinDiskBytes: 2048,
		ImageReference: "postgres:17", ComposeTemplate: "services:\n  database:\n    image: {{ .Image }}\n    environment:\n{{ .ExtraEnvironment }}"}
	for name, request := range map[string]ActionRequest{
		"below minimum":              {CPU: .5, MemoryBytes: 1024, DiskBytes: 2048, ExtraEnvironment: map[string]string{}},
		"missing environment object": {CPU: 1, MemoryBytes: 1024, DiskBytes: 2048},
		"reserved environment": {CPU: 2, MemoryBytes: 2048, DiskBytes: 4096,
			ExtraEnvironment: map[string]string{"DBMOCK_DB_PASSWORD": "override"}},
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := prepareRuntimeConfiguration(template, version, instance, request); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("expected invalid configuration, got %v", err)
			}
		})
	}
	_, _, err := prepareRuntimeConfiguration(template, version, instance, ActionRequest{
		CPU: 1, MemoryBytes: 1024, DiskBytes: 2048, ExtraEnvironment: map[string]string{"TZ": "UTC"},
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected unchanged configuration conflict, got %v", err)
	}
	target, _, err := prepareRuntimeConfiguration(template, version, instance, ActionRequest{
		CPU: 1, MemoryBytes: 1024, DiskBytes: 2048, ExtraEnvironment: map[string]string{"TZ": "UTC"},
		AutoRestart: boolPointer(true),
	})
	if err != nil || !target.AutoRestart {
		t.Fatalf("automatic restart should be a persisted runtime change: %#v, %v", target, err)
	}
}

func TestRuntimeConfigurationTaskPayloadDoesNotExposeEnvironmentValues(t *testing.T) {
	vault, err := appcrypto.NewVault(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	instanceID := uuid.New()
	configuration := json.RawMessage(`{"extraEnvironment":{"API_TOKEN":"plain-secret"}}`)
	encrypted, err := vault.Seal(configuration, runtimeConfigurationContext(instanceID))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(ActionPayload{InstanceID: instanceID, EncryptedTargetConfig: encrypted})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(payload), "plain-secret") {
		t.Fatalf("task payload leaked an environment value: %s", payload)
	}
	service := &Service{vault: vault}
	opened, err := service.openRuntimeConfiguration(instanceID, encrypted)
	if err != nil || !bytes.Equal(opened, configuration) {
		t.Fatalf("could not recover encrypted task configuration: %s, %v", opened, err)
	}
	if _, err = service.openRuntimeConfiguration(uuid.New(), encrypted); err == nil {
		t.Fatal("encrypted task configuration must be bound to its instance")
	}
}

func TestInstanceHasRuntimeConfigurationRequiresEveryPersistedField(t *testing.T) {
	raw := json.RawMessage(`{"extraEnvironment":{"TZ":"UTC"}}`)
	instance := domain.Instance{CPU: 2, MemoryBytes: 4096, ReservedDiskBytes: 8192, Configuration: raw, AutoRestart: true}
	target := runtimeConfiguration(2, 4096, 8192, raw, true)
	if !instanceHasRuntimeConfiguration(instance, target) {
		t.Fatal("expected exact target configuration to match")
	}
	target.MemoryBytes++
	if instanceHasRuntimeConfiguration(instance, target) {
		t.Fatal("a resource difference must not be treated as an already committed target")
	}
	target.MemoryBytes--
	target.AutoRestart = false
	if instanceHasRuntimeConfiguration(instance, target) {
		t.Fatal("a restart-policy difference must not be treated as an already committed target")
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

func TestNormalizeBackupName(t *testing.T) {
	now := time.Date(2026, 7, 20, 12, 0, 0, 0, time.UTC)
	name, err := normalizeBackupName("", now)
	if err != nil || name != "Backup 2026-07-20 12:00:00 UTC" {
		t.Fatalf("unexpected generated backup name %q: %v", name, err)
	}
	name, err = normalizeBackupName("  before migration  ", now)
	if err != nil || name != "before migration" {
		t.Fatalf("unexpected normalized backup name %q: %v", name, err)
	}
	if _, err = normalizeBackupName(strings.Repeat("x", 121), now); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected an overlong name to fail, got %v", err)
	}
	if _, err = normalizeBackupName("line one\nline two", now); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected a multiline name to fail, got %v", err)
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

func TestValidateBackupLifecycleStatuses(t *testing.T) {
	for _, status := range []string{"running", "stopped"} {
		if err := validateBackupSourceStatus(status); err != nil {
			t.Errorf("expected %s to allow backup creation: %v", status, err)
		}
	}
	for _, status := range []string{"running", "stopped", "degraded", "failed"} {
		if err := validateRestoreSourceStatus(status); err != nil {
			t.Errorf("expected %s to allow restore: %v", status, err)
		}
	}
	for _, status := range []string{"provisioning", "upgrading", "deleting"} {
		if !errors.Is(validateBackupSourceStatus(status), domain.ErrConflict) || !errors.Is(validateRestoreSourceStatus(status), domain.ErrConflict) {
			t.Errorf("expected %s to reject backup and restore", status)
		}
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

func TestValidateUpgradeImageSelection(t *testing.T) {
	artifactID := uuid.New()
	registryID := uuid.New()
	valid := []struct {
		source     string
		artifactID *uuid.UUID
		registryID *uuid.UUID
	}{
		{source: "public"},
		{source: "offline", artifactID: &artifactID},
		{source: "registry", registryID: &registryID},
	}
	for _, test := range valid {
		if err := validateUpgradeImageSelection(test.source, test.artifactID, test.registryID); err != nil {
			t.Errorf("expected %s selection to be valid: %v", test.source, err)
		}
	}
	invalid := []struct {
		source     string
		artifactID *uuid.UUID
		registryID *uuid.UUID
	}{
		{},
		{source: "public", artifactID: &artifactID},
		{source: "offline"},
		{source: "offline", artifactID: &artifactID, registryID: &registryID},
		{source: "registry"},
		{source: "unknown"},
	}
	for _, test := range invalid {
		if err := validateUpgradeImageSelection(test.source, test.artifactID, test.registryID); !errors.Is(err, domain.ErrInvalid) {
			t.Errorf("expected invalid selection %#v to fail, got %v", test, err)
		}
	}
}

func TestArtifactSupportsVersionRequiresEveryImageAndHostArchitecture(t *testing.T) {
	host := domain.Host{Architecture: "arm64"}
	version := domain.TemplateVersion{ImageReference: "database:17.1",
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
