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

func TestRegistryAndWebhookAuditChangesSanitizeEndpointsAndSecrets(t *testing.T) {
	registryChanges := registryAuditChanges(
		domain.Registry{URL: "https://registry.old.example.com", EncryptedPassword: "old-password", HasPassword: true},
		domain.Registry{URL: "https://registry.new.example.com", EncryptedPassword: "new-password", HasPassword: true, HasCACertificate: true},
		registryRequest{Password: "plain-password", CACertificate: "private-ca"},
	)
	webhookChanges := webhookAuditChanges(
		domain.Webhook{URL: "https://hooks.example.com/db?token=old-token", EncryptedSecret: "old-secret", HasSecret: true, Events: json.RawMessage(`["alert.created"]`)},
		domain.Webhook{URL: "https://hooks.example.com/db?token=new-token", EncryptedSecret: "new-secret", HasSecret: true, Events: json.RawMessage(`["task.failed"]`), Enabled: true},
		webhookRequest{Secret: "plain-secret"},
	)

	encoded, err := json.Marshal(map[string]any{"registry": registryChanges, "webhook": webhookChanges})
	if err != nil {
		t.Fatalf("marshal changes: %v", err)
	}
	text := string(encoded)
	for _, secret := range []string{"old-password", "new-password", "plain-password", "private-ca", "old-token", "new-token", "old-secret", "new-secret", "plain-secret"} {
		if strings.Contains(text, secret) {
			t.Fatalf("sensitive value %q leaked into audit changes: %s", secret, text)
		}
	}
	if registryChanges["passwordChanged"] != true || registryChanges["caCertificateChanged"] != true || webhookChanges["secretChanged"] != true {
		t.Fatalf("expected safe secret-change flags: %#v %#v", registryChanges, webhookChanges)
	}
	if webhookChanges["endpointChanged"] != true {
		t.Fatalf("query-only endpoint changes should retain a safe change flag: %#v", webhookChanges)
	}
}

func TestSettingAuditChangesOnlyExposeKnownStructuredSettings(t *testing.T) {
	known := settingAuditChanges("timezone", json.RawMessage(`"UTC"`), json.RawMessage(`"Asia/Shanghai"`))
	if known["value"] == nil {
		t.Fatalf("known setting should include its transition: %#v", known)
	}
	unknown := settingAuditChanges("customApiToken", json.RawMessage(`"old-secret"`), json.RawMessage(`"new-secret"`))
	if len(unknown) != 1 || unknown["valueChanged"] != true {
		t.Fatalf("unknown setting should only include a safe change flag: %#v", unknown)
	}
}

func TestInstanceReconfigureAuditChangesNeverIncludeEnvironmentValues(t *testing.T) {
	before := domain.Instance{CPU: 1, MemoryBytes: 1024, ReservedDiskBytes: 2048,
		Configuration: json.RawMessage(`{"extraEnvironment":{"API_TOKEN":"old-secret"}}`)}
	enabled := true
	changes := instanceReconfigureAuditChanges(before, 2, 4096, 8192,
		map[string]string{"API_TOKEN": "new-secret", "TZ": "Asia/Shanghai"}, &enabled)
	encoded, err := json.Marshal(changes)
	if err != nil {
		t.Fatalf("marshal changes: %v", err)
	}
	text := string(encoded)
	for _, secret := range []string{"old-secret", "new-secret", "Asia/Shanghai"} {
		if strings.Contains(text, secret) {
			t.Fatalf("environment value %q leaked into audit changes: %s", secret, text)
		}
	}
	if changes["environmentConfigurationChanged"] != true {
		t.Fatalf("expected a safe environment change flag: %#v", changes)
	}
	for _, key := range []string{"cpu", "memoryBytes", "reservedDiskBytes"} {
		if changes[key] == nil {
			t.Fatalf("expected %s transition: %#v", key, changes)
		}
	}
	if changes["autoRestart"] == nil {
		t.Fatalf("expected automatic restart transition: %#v", changes)
	}
}
