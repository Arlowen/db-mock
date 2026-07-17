package hostops

import "testing"

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
