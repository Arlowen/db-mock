package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func TestAddAuditTransitionOnlyRecordsChanges(t *testing.T) {
	changes := map[string]any{}
	addAuditTransition(changes, "unchanged", "same", "same")
	addAuditTransition(changes, "name", "before", "after")

	if _, exists := changes["unchanged"]; exists {
		t.Fatalf("unchanged value should not be recorded: %#v", changes)
	}
	transition, ok := changes["name"].(map[string]any)
	if !ok || transition["from"] != "before" || transition["to"] != "after" {
		t.Fatalf("unexpected transition: %#v", changes["name"])
	}
}

func TestHostAuditChangesNeverIncludeCredentialMaterial(t *testing.T) {
	projectBefore := uuid.New()
	projectAfter := uuid.New()
	before := domain.Host{
		ProjectID: &projectBefore, Name: "before", SSHAddress: "old.example.com", SSHPort: 22,
		SSHUser: "root", AuthType: "private_key", EncryptedCredential: "encrypted-old-secret",
		HostKey: "old-host-key", ProxyHTTPS: "https://user:old-token@proxy.example.com",
		Labels: json.RawMessage(`{"region":"east"}`),
	}
	after := before
	after.ProjectID = &projectAfter
	after.Name = "after"
	after.EncryptedCredential = "encrypted-new-secret"
	after.HostKey = "new-host-key"
	after.ProxyHTTPS = "https://user:new-token@proxy.example.com"
	after.Labels = json.RawMessage(`{"region":"west"}`)
	input := hostRequest{Credential: "plain-credential", HostKey: after.HostKey}

	changes := hostAuditChanges(before, after, input)
	encoded, err := json.Marshal(changes)
	if err != nil {
		t.Fatalf("marshal changes: %v", err)
	}
	text := string(encoded)
	for _, secret := range []string{"encrypted-old-secret", "encrypted-new-secret", "plain-credential", "old-host-key", "new-host-key", "old-token", "new-token"} {
		if strings.Contains(text, secret) {
			t.Fatalf("sensitive value %q leaked into audit changes: %s", secret, text)
		}
	}
	for _, flag := range []string{"credentialChanged", "hostKeyChanged", "proxyConfigurationChanged"} {
		if changes[flag] != true {
			t.Fatalf("expected %s flag, got %#v", flag, changes)
		}
	}
}
