package store

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestCreateInstanceTaskRejectsMismatchedSourceReferencesBeforeWriting(t *testing.T) {
	instanceID, hostID, versionID, registryID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	target := &Store{}
	_, _, err := target.CreateInstanceTask(context.Background(), InstanceInput{
		ID: instanceID, Name: "database", HostID: hostID, TemplateVersionID: versionID,
		CPU: 1, MemoryBytes: 1024, ReservedDiskBytes: 2048,
		Configuration: json.RawMessage(`{"registryId":"` + registryID.String() + `"}`),
	}, TaskInput{RequestedBy: uuid.New(), Payload: map[string]any{"instanceId": instanceID}})
	if !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expected mismatched task and instance image sources to be rejected, got %v", err)
	}
}

func TestRuntimeConfigurationFitsAllowsGrandfatheredResourcesButRejectsGrowth(t *testing.T) {
	current := InstanceRuntimeConfiguration{CPU: 4, MemoryBytes: 400, ReservedDiskBytes: 400}
	if !runtimeConfigurationFits(current, current, 6, 8, 600, 800, 600, 800) {
		t.Fatal("an environment-only change should remain possible when existing reservations exceed refreshed host capacity")
	}
	decrease := InstanceRuntimeConfiguration{CPU: 2, MemoryBytes: 300, ReservedDiskBytes: 300}
	if !runtimeConfigurationFits(current, decrease, 6, 8, 600, 800, 600, 800) {
		t.Fatal("resource reductions should remain possible on an overcommitted host")
	}
	memoryGrowth := InstanceRuntimeConfiguration{CPU: 2, MemoryBytes: 500, ReservedDiskBytes: 300}
	if runtimeConfigurationFits(current, memoryGrowth, 6, 8, 600, 800, 600, 800) {
		t.Fatal("a resource dimension must not grow beyond its schedulable host limit")
	}
}

func TestRuntimeConfigurationFitsAcceptsGrowthWithinHeadroom(t *testing.T) {
	current := InstanceRuntimeConfiguration{CPU: 1, MemoryBytes: 100, ReservedDiskBytes: 100}
	target := InstanceRuntimeConfiguration{CPU: 2, MemoryBytes: 200, ReservedDiskBytes: 200}
	if !runtimeConfigurationFits(current, target, 2, 8, 200, 800, 200, 800) {
		t.Fatal("expected target configuration to fit available host headroom")
	}
}
