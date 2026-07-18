package hostops

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestShellQuote(t *testing.T) {
	got := ShellQuote("a'b; $(bad)")
	want := `'a'"'"'b; $(bad)'`
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestParseKeyValues(t *testing.T) {
	values := ParseKeyValues("os=Linux\ndisk=10|4\nignored\n")
	if values["os"] != "Linux" || values["disk"] != "10|4" {
		t.Fatalf("unexpected values: %#v", values)
	}
}

func TestProbeResultUsesFrontendJSONContract(t *testing.T) {
	data, err := json.Marshal(ProbeResult{
		HostKey:          "SHA256:example",
		DockerVersion:    "27.5.1",
		PasswordlessSudo: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	value := string(data)
	for _, expected := range []string{`"hostKey":"SHA256:example"`, `"dockerVersion":"27.5.1"`, `"passwordlessSudo":true`} {
		if !strings.Contains(value, expected) {
			t.Fatalf("expected %s in %s", expected, value)
		}
	}
	if strings.Contains(value, `"HostKey"`) || strings.Contains(value, `"DockerVersion"`) {
		t.Fatalf("unexpected Go field names in JSON: %s", value)
	}
}
