package api

import (
	"encoding/json"
	"testing"
)

func TestTimezoneSettingViewUsesStoredOrDeploymentTimezone(t *testing.T) {
	if got := string(timezoneSettingView(json.RawMessage(`"America/New_York"`), "UTC")); got != `"America/New_York"` {
		t.Fatalf("stored timezone was not preserved: %s", got)
	}
	if got := string(timezoneSettingView(json.RawMessage(`"invalid"`), "UTC")); got != `"UTC"` {
		t.Fatalf("invalid stored timezone should use the deployment fallback: %s", got)
	}
}
