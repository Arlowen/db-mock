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
