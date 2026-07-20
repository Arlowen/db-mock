package api

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNormalizeWebhook(t *testing.T) {
	tests := []struct {
		name       string
		input      webhookRequest
		valid      bool
		wantName   string
		wantURL    string
		wantEvents []string
	}{
		{name: "specific events", input: webhookRequest{Name: " Engineering ", URL: " https://hooks.example.com/dbmock?token=one ", Events: []string{"alert.created", "alert.created", "task.failed"}}, valid: true, wantName: "Engineering", wantURL: "https://hooks.example.com/dbmock?token=one", wantEvents: []string{"alert.created", "task.failed"}},
		{name: "wildcard replaces specifics", input: webhookRequest{Name: "All", URL: "http://hooks.internal:8080/events", Events: []string{"task.failed", "*"}}, valid: true, wantName: "All", wantURL: "http://hooks.internal:8080/events", wantEvents: []string{"*"}},
		{name: "missing events", input: webhookRequest{Name: "None", URL: "https://hooks.example.com"}},
		{name: "unsupported event", input: webhookRequest{Name: "Bad", URL: "https://hooks.example.com", Events: []string{"unknown.event"}}},
		{name: "embedded credentials", input: webhookRequest{Name: "Bad", URL: "https://user:secret@hooks.example.com", Events: []string{"alert.created"}}},
		{name: "fragment", input: webhookRequest{Name: "Bad", URL: "https://hooks.example.com/path#secret", Events: []string{"alert.created"}}},
		{name: "invalid scheme", input: webhookRequest{Name: "Bad", URL: "file:///tmp/hook", Events: []string{"alert.created"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := test.input
			err := normalizeWebhook(&input)
			if test.valid && err != nil {
				t.Fatalf("expected valid webhook, got %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected webhook validation to fail")
			}
			if test.valid {
				if input.Name != test.wantName || input.URL != test.wantURL {
					t.Fatalf("normalized name=%q url=%q", input.Name, input.URL)
				}
				if len(input.Events) != len(test.wantEvents) {
					t.Fatalf("events=%v, want %v", input.Events, test.wantEvents)
				}
				for index := range test.wantEvents {
					if input.Events[index] != test.wantEvents[index] {
						t.Fatalf("events=%v, want %v", input.Events, test.wantEvents)
					}
				}
			}
		})
	}
}

func TestNormalizeSettingValueValidatesMonitoringPolicy(t *testing.T) {
	normalized, err := normalizeSettingValue("monitoring", json.RawMessage(`{"alerts":{"hostOffline":false}}`), 50*1024*1024*1024, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(normalized) || !strings.Contains(string(normalized), `"intervalSeconds":30`) || !strings.Contains(string(normalized), `"hostOffline":false`) {
		t.Fatalf("unexpected normalized monitoring setting: %s", normalized)
	}
	if _, err = normalizeSettingValue("monitoring", json.RawMessage(`{"diskWarningPercent":95,"diskCriticalPercent":90}`), 50*1024*1024*1024, "Asia/Shanghai"); err == nil {
		t.Fatal("expected invalid thresholds to be rejected")
	}
}

func TestNormalizeSettingValueValidatesUploadPolicyAgainstDeploymentCeiling(t *testing.T) {
	const gib = int64(1024 * 1024 * 1024)
	normalized, err := normalizeSettingValue("uploads", json.RawMessage(`{"maxBytes":10737418240,"chunkBytes":4194304}`), 20*gib, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(normalized), `"maxBytes":10737418240`) || !strings.Contains(string(normalized), `"chunkBytes":4194304`) {
		t.Fatalf("unexpected normalized upload policy: %s", normalized)
	}
	if _, err = normalizeSettingValue("uploads", json.RawMessage(`{"maxBytes":21474836480,"chunkBytes":4194304}`), 10*gib, "Asia/Shanghai"); err == nil {
		t.Fatal("expected deployment ceiling to be enforced")
	}

	view := string(uploadSettingView(json.RawMessage(`{"maxBytes":53687091200,"chunkBytes":8388608}`), 10*gib))
	if !strings.Contains(view, `"maxBytes":10737418240`) || !strings.Contains(view, `"maxAllowedBytes":10737418240`) {
		t.Fatalf("invalid stored policy should fall back to the effective deployment ceiling: %s", view)
	}
}

func TestNormalizeSettingValueValidatesTimezone(t *testing.T) {
	normalized, err := normalizeSettingValue("timezone", json.RawMessage(`" America/New_York "`), 50*1024*1024*1024, "Asia/Shanghai")
	if err != nil || string(normalized) != `"America/New_York"` {
		t.Fatalf("unexpected normalized timezone: %s, %v", normalized, err)
	}
	if _, err = normalizeSettingValue("timezone", json.RawMessage(`"browser-local"`), 50*1024*1024*1024, "Asia/Shanghai"); err == nil {
		t.Fatal("expected invalid timezone to be rejected")
	}
	if got := string(timezoneSettingView(json.RawMessage(`"invalid"`), "UTC")); got != `"UTC"` {
		t.Fatalf("invalid stored timezone should use the deployment fallback: %s", got)
	}
}

func TestSafeCSVCellPreventsSpreadsheetFormulas(t *testing.T) {
	for _, value := range []string{"=cmd()", "+SUM(1,1)", "-1+2", "@IMPORTDATA", "  =cmd()"} {
		if got := safeCSVCell(value); got != "'"+value {
			t.Fatalf("expected %q to be escaped, got %q", value, got)
		}
	}
	for _, value := range []string{"admin", "10.0.0.8", "", "completed"} {
		if got := safeCSVCell(value); got != value {
			t.Fatalf("expected %q to stay unchanged, got %q", value, got)
		}
	}
}
