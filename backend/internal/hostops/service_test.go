package hostops

import "testing"

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
