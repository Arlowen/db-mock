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

func TestParseByteCountAcceptsIntegerAndScientificNotation(t *testing.T) {
	for _, item := range []struct {
		value string
		want  int64
	}{
		{value: "8589934592", want: 8589934592},
		{value: "8.58993e+09", want: 8589930000},
		{value: " 0 ", want: 0},
	} {
		got, ok := parseByteCount(item.value)
		if !ok || got != item.want {
			t.Fatalf("parseByteCount(%q) = %d, %v; want %d, true", item.value, got, ok, item.want)
		}
	}
	for _, value := range []string{"", "unknown", "-1", "NaN", "Inf"} {
		if got, ok := parseByteCount(value); ok {
			t.Fatalf("parseByteCount(%q) = %d, true; want invalid", value, got)
		}
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
