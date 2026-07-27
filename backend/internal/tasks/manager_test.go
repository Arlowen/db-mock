package tasks

import (
	"context"
	"errors"
	"testing"
)

func TestClassifyTaskFailure(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		wantCode string
	}{
		{name: "ssh unreachable", err: errors.New("restart instance: dial SSH db-host:22: lookup db-host: no such host"), wantCode: "ssh_unreachable"},
		{name: "ssh credential", err: errors.New("connect host: SSH credential is invalid: the server rejected the configured private key"), wantCode: "ssh_credential_invalid"},
		{name: "ssh host key", err: errors.New("connect host: SSH host key changed: expected old, received new"), wantCode: "ssh_host_key_changed"},
		{name: "timeout", err: context.DeadlineExceeded, wantCode: "operation_timeout"},
		{name: "disk full", err: errors.New("remote command failed (exit 1): write /data: no space left on device"), wantCode: "host_disk_full"},
		{name: "port conflict", err: errors.New("driver failed programming external connectivity: bind: address already in use"), wantCode: "port_conflict"},
		{name: "health check", err: errors.New("instance health check failed: state=degraded health=unhealthy"), wantCode: "health_check_failed"},
		{name: "image pull", err: errors.New("remote command failed (exit 1): failed to resolve reference postgres:17: unexpected EOF"), wantCode: "image_pull_failed"},
		{name: "unknown", err: errors.New("unexpected managed operation failure"), wantCode: "task_failed"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := classifyTaskFailure(test.err); got != test.wantCode {
				t.Fatalf("classifyTaskFailure() = %q, want %q", got, test.wantCode)
			}
		})
	}
}
