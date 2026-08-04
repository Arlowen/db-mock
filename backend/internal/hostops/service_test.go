package hostops

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestEnqueueRejectsRetiredDockerManagementBeforeStoreAccess(t *testing.T) {
	service := &Service{}
	for _, action := range []string{"install_docker", "upgrade_docker", "configure_proxy"} {
		if _, err := service.Enqueue(context.Background(), uuid.New(), uuid.New(), action); !errors.Is(err, domain.ErrInvalid) {
			t.Fatalf("retired action %s error = %v, want invalid", action, err)
		}
	}
}

func TestProbeStatusRequiresAUsableManagedRootAndPortInspector(t *testing.T) {
	ready := ProbeResult{OS: "linux", Architecture: "amd64", DockerVersion: "27.5.1", ComposeVersion: "2.35.1",
		DataRootWritable: true, PortProbeAvailable: true, FirstAvailablePort: 20000}
	if status, message := ProbeStatus(ready); status != "online" || message != "" {
		t.Fatalf("ready probe = %q, %q", status, message)
	}
	unwritable := ready
	unwritable.DataRootWritable = false
	if status, message := ProbeStatus(unwritable); status != "degraded" || message != DataRootUnavailableMessage {
		t.Fatalf("unwritable root = %q, %q", status, message)
	}
	withoutPortProbe := ready
	withoutPortProbe.PortProbeAvailable = false
	if status, message := ProbeStatus(withoutPortProbe); status != "unsupported" || message != PortProbeUnavailableMessage {
		t.Fatalf("missing port inspector = %q, %q", status, message)
	}
	withoutDocker := ready
	withoutDocker.DockerVersion = ""
	if status, message := ProbeStatus(withoutDocker); status != "needs_docker" || message != DockerUnavailableMessage {
		t.Fatalf("missing Docker = %q, %q", status, message)
	}
}
