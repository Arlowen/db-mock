package store

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/pika/db-mock/internal/domain"
)

func TestTranslateUniqueViolation(t *testing.T) {
	err := translate(&pgconn.PgError{Code: "23505"})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("expected unique violation to become a resource conflict, got %v", err)
	}
}

func TestNormalizeProjectInputValidatesDeploymentDefaults(t *testing.T) {
	environment := " testing "
	expiryDays := 14
	input, err := normalizeProjectInput(ProjectInput{
		Name:               " Orders ",
		DefaultEnvironment: &environment,
		DefaultExpiryDays:  &expiryDays,
		DefaultLabels:      json.RawMessage(`{"team":"orders"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	if input.Name != "Orders" || input.DefaultEnvironment == nil || *input.DefaultEnvironment != "testing" ||
		input.DefaultExpiryDays == nil || *input.DefaultExpiryDays != 14 ||
		string(input.DefaultLabels) != `{"team":"orders"}` {
		t.Fatalf("unexpected normalized project input: %#v", input)
	}

	unsupported := "sandbox"
	if _, err = normalizeProjectInput(ProjectInput{Name: "Orders", DefaultEnvironment: &unsupported}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("unsupported environment error = %v, want invalid input", err)
	}
	tooLong := 366
	if _, err = normalizeProjectInput(ProjectInput{Name: "Orders", DefaultExpiryDays: &tooLong}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expiry error = %v, want invalid input", err)
	}
	if _, err = normalizeProjectInput(ProjectInput{Name: "Orders", DefaultLabels: json.RawMessage(`["orders"]`)}); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("labels error = %v, want invalid input", err)
	}
}

func TestTaskInsertErrorExplainsActiveResourceConflict(t *testing.T) {
	err := taskInsertError(&pgconn.PgError{Code: "23505", ConstraintName: "tasks_active_resource_idx"})
	if !errors.Is(err, domain.ErrConflict) || !strings.Contains(err.Error(), "another operation") {
		t.Fatalf("expected an actionable active-task conflict, got %v", err)
	}
}

func TestTaskRetryPayloadKeepsRollbackLineageOnlyForInterruptedWork(t *testing.T) {
	originalTaskID, retryTaskID := uuid.New(), uuid.New()
	payload, err := taskRetryPayload(json.RawMessage(`{"instanceId":"instance-fixture"}`), originalTaskID, "interrupted")
	if err != nil {
		t.Fatal(err)
	}
	var interrupted struct {
		InstanceID            string     `json:"instanceId"`
		OperationID           *uuid.UUID `json:"operationId"`
		ReuseRollbackSnapshot bool       `json:"reuseRollbackSnapshot"`
	}
	if err = json.Unmarshal(payload, &interrupted); err != nil {
		t.Fatal(err)
	}
	if interrupted.InstanceID != "instance-fixture" || interrupted.OperationID == nil ||
		*interrupted.OperationID != originalTaskID || !interrupted.ReuseRollbackSnapshot {
		t.Fatalf("interrupted retry payload = %s", payload)
	}

	payload, err = taskRetryPayload(payload, retryTaskID, "failed")
	if err != nil {
		t.Fatal(err)
	}
	var failed struct {
		OperationID           *uuid.UUID `json:"operationId"`
		ReuseRollbackSnapshot bool       `json:"reuseRollbackSnapshot"`
	}
	if err = json.Unmarshal(payload, &failed); err != nil {
		t.Fatal(err)
	}
	if failed.OperationID == nil || *failed.OperationID != originalTaskID || failed.ReuseRollbackSnapshot {
		t.Fatalf("failed retry payload = %s", payload)
	}

	if _, err = taskRetryPayload(json.RawMessage(`{"operationId":"not-a-uuid"}`), retryTaskID, "interrupted"); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("invalid operation lineage should fail, got %v", err)
	}
}
