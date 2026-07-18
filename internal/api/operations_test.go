package api

import "testing"

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
