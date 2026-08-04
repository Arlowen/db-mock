package api

import (
	"errors"
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
