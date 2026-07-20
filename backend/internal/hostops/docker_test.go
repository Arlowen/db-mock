package hostops

import "testing"

func TestValidateManagedDirectory(t *testing.T) {
	if err := validateManagedDirectory("/opt/dbmock", "/opt/dbmock/instances/123"); err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"/", "/opt/dbmock", "/opt/dbmock/other", "/opt/dbmock/instances/../outside"} {
		if err := validateManagedDirectory("/opt/dbmock", value); err == nil {
			t.Fatalf("expected %q to fail", value)
		}
	}
}

func TestParseDockerSize(t *testing.T) {
	if got := parseDockerSize("1.5GiB"); got != 1610612736 {
		t.Fatalf("got %d", got)
	}
}

func TestParseManagedStatesMarksMixedContainersDegraded(t *testing.T) {
	states := parseManagedStates("one|running\none|exited\ntwo|running\ntwo|running\n")
	if states["one"] != "degraded" || states["two"] != "running" {
		t.Fatalf("unexpected states: %#v", states)
	}
}

func TestRegistryServerStripsURLScheme(t *testing.T) {
	if got := registryServer("https://harbor.example.com:5443/"); got != "harbor.example.com:5443" {
		t.Fatalf("got %q", got)
	}
}
