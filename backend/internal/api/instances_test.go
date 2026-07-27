package api

import (
	"errors"
	"fmt"
	"testing"

	"github.com/pika/db-mock/internal/domain"
)

func TestBatchActionErrorKeepsActionableDomainFailures(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantCode    string
		wantMessage string
	}{
		{name: "not found", err: domain.ErrNotFound, wantCode: "not_found", wantMessage: "Resource not found"},
		{name: "conflict", err: fmt.Errorf("%w: instance action is not allowed for the current status", domain.ErrConflict), wantCode: "resource_conflict", wantMessage: "resource conflict: instance action is not allowed for the current status"},
		{name: "unavailable", err: fmt.Errorf("%w: unable to reach the host", domain.ErrUnavailable), wantCode: "resource_unavailable", wantMessage: "resource temporarily unavailable: unable to reach the host"},
		{name: "internal", err: errors.New("database password leaked here"), wantCode: "internal_error", wantMessage: "Internal server error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, message := batchActionError(test.err)
			if code != test.wantCode || message != test.wantMessage {
				t.Fatalf("batchActionError(%v) = %q, %q; want %q, %q", test.err, code, message, test.wantCode, test.wantMessage)
			}
		})
	}
}
