package store

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMarshalAuditChangesRedactsSecretsAndKeepsSafeFlags(t *testing.T) {
	raw, err := marshalAuditChanges(map[string]any{
		"password":        "plain-password",
		"passwordChanged": true,
		"nested": map[string]any{
			"api_token":     "token-value",
			"displayName":   "Database Admin",
			"hasCredential": false,
		},
		"items": []any{map[string]any{"privateKey": "private-key", "status": "active"}},
	})
	if err != nil {
		t.Fatalf("marshal audit changes: %v", err)
	}
	text := string(raw)
	for _, secret := range []string{"plain-password", "token-value", "private-key"} {
		if strings.Contains(text, secret) {
			t.Fatalf("secret %q leaked into audit changes: %s", secret, text)
		}
	}
	var decoded map[string]any
	if err = json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("decode audit changes: %v", err)
	}
	if decoded["password"] != "[REDACTED]" || decoded["passwordChanged"] != true {
		t.Fatalf("unexpected top-level redaction: %#v", decoded)
	}
	nested := decoded["nested"].(map[string]any)
	if nested["api_token"] != "[REDACTED]" || nested["displayName"] != "Database Admin" || nested["hasCredential"] != false {
		t.Fatalf("unexpected nested redaction: %#v", nested)
	}
}

func TestMarshalAuditChangesHandlesNil(t *testing.T) {
	raw, err := marshalAuditChanges(nil)
	if err != nil || string(raw) != "null" {
		t.Fatalf("expected null without error, got %q, %v", raw, err)
	}
}
