package tasks

import (
	"errors"
	"testing"
)

func TestFailureResultPreservesTheOriginalError(t *testing.T) {
	original := errors.New("restore failed")
	result := map[string]any{"restoreOutcome": "pre_restore_recovered"}
	wrapped := WithFailureResult(original, result)

	if !errors.Is(wrapped, original) {
		t.Fatalf("wrapped error does not preserve the original error: %v", wrapped)
	}
	got, ok := failureResult(wrapped).(map[string]any)
	if !ok || got["restoreOutcome"] != "pre_restore_recovered" {
		t.Fatalf("failure result = %#v", got)
	}
	if WithFailureResult(nil, result) != nil {
		t.Fatal("nil error must remain nil")
	}
}
