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

func TestParseManagedStatesAggregatesProcessAndHealth(t *testing.T) {
	states := parseManagedStates("one|running|healthy\none|running|unhealthy\n" +
		"two|running|starting\ntwo|running|healthy\n" +
		"three|exited|\nthree|dead|\n" +
		"four|running|healthy\nfour|exited|unhealthy\n")
	tests := map[string]ManagedState{
		"one":   {State: "running", Health: "unhealthy"},
		"two":   {State: "running", Health: "starting"},
		"three": {State: "stopped", Health: ""},
		"four":  {State: "degraded", Health: "unhealthy"},
	}
	for id, want := range tests {
		if got := states[id]; got != want {
			t.Errorf("state %s = %#v, want %#v", id, got, want)
		}
	}
}

func TestRegistryServerStripsURLScheme(t *testing.T) {
	if got := registryServer("https://harbor.example.com:5443/"); got != "harbor.example.com:5443" {
		t.Fatalf("got %q", got)
	}
}
