package api

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
	"github.com/pika/db-mock/internal/instances"
)

func TestMVPCreateRequestOnlyAcceptsMinimumDeploymentFields(t *testing.T) {
	allowed := `{"name":"orders_test","templateVersionId":"11111111-1111-4111-8111-111111111111","hostId":null,"cpu":1,"memoryBytes":1073741824,"diskBytes":10737418240,"templateParameters":{}}`
	request := httptest.NewRequest(http.MethodPost, "/instances", strings.NewReader(allowed))
	var input instances.CreateRequest
	if err := httpx.Decode(request, &input); err != nil {
		t.Fatalf("minimum request should decode: %v", err)
	}
	if input.Name != "orders_test" || input.CPU != 1 || input.MemoryBytes != 1073741824 || input.DiskBytes != 10737418240 {
		t.Fatalf("decoded minimum request = %#v", input)
	}

	for _, retired := range []string{
		"projectId", "environment", "labels", "purpose", "owner", "expiresAt", "autoRestart",
		"hostPort", "bindAddress", "username", "password", "databaseName", "extraEnvironment",
		"imageArtifactId", "registryId",
	} {
		body := `{"name":"orders_test","templateVersionId":"11111111-1111-4111-8111-111111111111","` + retired + `":null}`
		request = httptest.NewRequest(http.MethodPost, "/instances", strings.NewReader(body))
		input = instances.CreateRequest{}
		if err := httpx.Decode(request, &input); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("retired field %s should be rejected, got %v", retired, err)
		}
	}
}

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
