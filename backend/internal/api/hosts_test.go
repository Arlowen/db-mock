package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func TestMVPHostRequestRejectsRetiredManagementAndPolicyFields(t *testing.T) {
	for _, retired := range []string{"projectId", "manageDocker", "proxyHttp", "proxyHttps", "proxyNoProxy", "maintenance", "autoRestartDefault", "labels"} {
		body := `{"name":"daily-host","sshAddress":"192.0.2.10","sshPort":22,"sshUser":"dbmock",` +
			`"authType":"password","credential":"synthetic","dataRoot":"/opt/dbmock","portStart":20000,` +
			`"portEnd":40000,"` + retired + `":null}`
		request := httptest.NewRequest(http.MethodPost, "/hosts", strings.NewReader(body))
		var input hostRequest
		if err := httpx.Decode(request, &input); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("retired field %s should be rejected, got %v", retired, err)
		}
	}
}
