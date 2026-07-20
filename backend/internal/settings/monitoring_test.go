package settings

import (
	"encoding/json"
	"testing"
)

func TestDecodeMonitoringPolicyBackfillsAlertDefaults(t *testing.T) {
	defaults := DefaultMonitoringPolicy(30, 7)
	policy, err := DecodeMonitoringPolicy(json.RawMessage(`{
		"intervalSeconds":45,
		"retentionDays":14,
		"diskWarningPercent":75,
		"diskCriticalPercent":92,
		"alerts":{"hostOffline":false,"containerExited":false}
	}`), defaults)
	if err != nil {
		t.Fatal(err)
	}
	if policy.IntervalSeconds != 45 || policy.RetentionDays != 14 {
		t.Fatalf("unexpected collection policy: %#v", policy)
	}
	if policy.AlertEnabled(AlertHostOffline) || policy.AlertEnabled(AlertContainerExited) {
		t.Fatalf("explicitly disabled alerts were not preserved: %#v", policy.Alerts)
	}
	for _, alertType := range []string{AlertSSHCredentialInvalid, AlertContainerUnhealthy, AlertRestartFailed, AlertDiskWarning, AlertDiskCritical, AlertUpgradeFailed} {
		if !policy.AlertEnabled(alertType) {
			t.Fatalf("legacy policy should default %s to enabled", alertType)
		}
	}
}

func TestNormalizeMonitoringPolicyRejectsUnsafeOrUnknownValues(t *testing.T) {
	invalid := []string{
		`{"intervalSeconds":4}`,
		`{"retentionDays":0}`,
		`{"diskWarningPercent":90,"diskCriticalPercent":80}`,
		`{"alerts":{"hostOffline":"yes"}}`,
		`{"alerts":{"typoAlert":false}}`,
		`{"unknown":true}`,
	}
	for _, raw := range invalid {
		if _, err := NormalizeMonitoringPolicy(json.RawMessage(raw)); err == nil {
			t.Fatalf("expected invalid monitoring policy to be rejected: %s", raw)
		}
	}
}

func TestNormalizeMonitoringPolicyReturnsCompletePolicy(t *testing.T) {
	raw, err := NormalizeMonitoringPolicy(json.RawMessage(`{"alerts":{"diskWarning":false}}`))
	if err != nil {
		t.Fatal(err)
	}
	var policy MonitoringPolicy
	if err = json.Unmarshal(raw, &policy); err != nil {
		t.Fatal(err)
	}
	if policy.Alerts.DiskWarning || !policy.Alerts.SSHCredentialInvalid || policy.IntervalSeconds != 30 || policy.RetentionDays != 7 {
		t.Fatalf("unexpected normalized policy: %#v", policy)
	}
}

func TestDefaultMonitoringPolicyClampsInvalidEnvironmentFallbacks(t *testing.T) {
	for _, defaults := range []MonitoringPolicy{DefaultMonitoringPolicy(1, 0), DefaultMonitoringPolicy(7200, 500)} {
		if defaults.IntervalSeconds != 30 || defaults.RetentionDays != 7 {
			t.Fatalf("invalid environment fallback was not clamped: %#v", defaults)
		}
	}
}
