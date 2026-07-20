package settings

import (
	"encoding/json"
	"testing"
)

func TestNormalizeTimezoneAcceptsIANANames(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want string
	}{
		{raw: `"UTC"`, want: `"UTC"`},
		{raw: `" Asia/Shanghai "`, want: `"Asia/Shanghai"`},
		{raw: `"America/New_York"`, want: `"America/New_York"`},
	} {
		normalized, err := NormalizeTimezone(json.RawMessage(test.raw))
		if err != nil {
			t.Fatalf("NormalizeTimezone(%s): %v", test.raw, err)
		}
		if string(normalized) != test.want {
			t.Fatalf("NormalizeTimezone(%s) = %s, want %s", test.raw, normalized, test.want)
		}
	}
}

func TestNormalizeTimezoneRejectsInvalidValues(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `""`, `"Local"`, `"Mars/Olympus"`} {
		if _, err := NormalizeTimezone(json.RawMessage(raw)); err == nil {
			t.Fatalf("expected invalid timezone to be rejected: %s", raw)
		}
	}
}

func TestEffectiveTimezoneUsesValidatedFallback(t *testing.T) {
	if got := EffectiveTimezone(json.RawMessage(`"Europe/London"`), "UTC"); got != "Europe/London" {
		t.Fatalf("valid stored timezone was not preserved: %s", got)
	}
	if got := EffectiveTimezone(json.RawMessage(`"invalid"`), "UTC"); got != "UTC" {
		t.Fatalf("invalid stored timezone did not use deployment fallback: %s", got)
	}
	if got := EffectiveTimezone(nil, "invalid"); got != DefaultTimezone {
		t.Fatalf("invalid fallback did not use application default: %s", got)
	}
}
