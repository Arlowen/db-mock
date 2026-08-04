package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
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
		{name: "specific events", input: webhookRequest{Name: " Engineering ", URL: " https://hooks.example.com/dbmock?token=one ", Events: []string{"alert.created", "alert.created", "task.failed", "task.canceled", "task.interrupted"}}, valid: true, wantName: "Engineering", wantURL: "https://hooks.example.com/dbmock?token=one", wantEvents: []string{"alert.created", "task.failed", "task.canceled", "task.interrupted"}},
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

func TestTimezoneSettingViewUsesStoredOrDeploymentTimezone(t *testing.T) {
	if got := string(timezoneSettingView(json.RawMessage(`"America/New_York"`), "UTC")); got != `"America/New_York"` {
		t.Fatalf("stored timezone was not preserved: %s", got)
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

func TestAuditPaginationUsesSafeDefaultsAndBounds(t *testing.T) {
	tests := []struct {
		query        string
		wantPage     int
		wantPageSize int
	}{
		{query: "", wantPage: 1, wantPageSize: 20},
		{query: "?page=3&pageSize=50", wantPage: 3, wantPageSize: 50},
		{query: "?page=0&pageSize=0", wantPage: 1, wantPageSize: 20},
		{query: "?page=1000001&pageSize=101", wantPage: 1, wantPageSize: 20},
		{query: "?page=invalid&pageSize=invalid", wantPage: 1, wantPageSize: 20},
	}
	for _, test := range tests {
		request := httptest.NewRequest("GET", "/audit"+test.query, nil)
		page, pageSize := auditPagination(request)
		if page != test.wantPage || pageSize != test.wantPageSize {
			t.Fatalf("%s: got page=%d pageSize=%d, want page=%d pageSize=%d", test.query, page, pageSize, test.wantPage, test.wantPageSize)
		}
	}
}

func TestAuditClearRejectsFutureCutoff(t *testing.T) {
	now := time.Now()
	if validAuditClearInput("CLEAR", now.Add(time.Minute), now) {
		t.Fatal("expected a future cutoff to be rejected")
	}
	if validAuditClearInput("clear", now.Add(-time.Hour), now) {
		t.Fatal("expected an invalid confirmation to be rejected")
	}
	if validAuditClearInput("CLEAR", time.Time{}, now) {
		t.Fatal("expected an empty cutoff to be rejected")
	}
	if !validAuditClearInput("CLEAR", now.Add(-time.Hour), now) {
		t.Fatal("expected a confirmed past cutoff to be accepted")
	}
}
