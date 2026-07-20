package api

import (
	"encoding/json"
	"net/url"
	"reflect"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

func addAuditTransition(changes map[string]any, key string, before, after any) {
	if reflect.DeepEqual(before, after) {
		return
	}
	changes[key] = map[string]any{"from": before, "to": after}
}

func auditUUID(value *uuid.UUID) any {
	if value == nil {
		return nil
	}
	return value.String()
}

func auditJSON(value json.RawMessage) any {
	if len(value) == 0 {
		return nil
	}
	var decoded any
	if err := json.Unmarshal(value, &decoded); err != nil {
		return string(value)
	}
	return decoded
}

// auditURL removes fields that commonly carry credentials while keeping enough
// of the endpoint to explain a configuration change.
func auditURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	parsed.User = nil
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	return parsed.String()
}

func projectAuditChanges(before, after domain.Project) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "name", before.Name, after.Name)
	addAuditTransition(changes, "description", before.Description, after.Description)
	addAuditTransition(changes, "color", before.Color, after.Color)
	return changes
}

func hostAuditChanges(before, after domain.Host, input hostRequest) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "name", before.Name, after.Name)
	addAuditTransition(changes, "projectId", auditUUID(before.ProjectID), auditUUID(after.ProjectID))
	addAuditTransition(changes, "sshAddress", before.SSHAddress, after.SSHAddress)
	addAuditTransition(changes, "sshPort", before.SSHPort, after.SSHPort)
	addAuditTransition(changes, "sshUser", before.SSHUser, after.SSHUser)
	addAuditTransition(changes, "authType", before.AuthType, after.AuthType)
	addAuditTransition(changes, "connectionAddress", before.ConnectionAddress, after.ConnectionAddress)
	addAuditTransition(changes, "dataRoot", before.DataRoot, after.DataRoot)
	addAuditTransition(changes, "portStart", before.PortStart, after.PortStart)
	addAuditTransition(changes, "portEnd", before.PortEnd, after.PortEnd)
	addAuditTransition(changes, "manageDocker", before.ManageDocker, after.ManageDocker)
	addAuditTransition(changes, "maintenance", before.Maintenance, after.Maintenance)
	addAuditTransition(changes, "autoRestartDefault", before.AutoRestartDefault, after.AutoRestartDefault)
	addAuditTransition(changes, "labels", auditJSON(before.Labels), auditJSON(after.Labels))
	if input.Credential != "" {
		changes["credentialChanged"] = true
	}
	if input.HostKey != "" && input.HostKey != before.HostKey {
		changes["hostKeyChanged"] = true
	}
	if before.ProxyHTTP != after.ProxyHTTP || before.ProxyHTTPS != after.ProxyHTTPS || before.ProxyNoProxy != after.ProxyNoProxy {
		changes["proxyConfigurationChanged"] = true
	}
	return changes
}

func instanceAuditChanges(before, after domain.Instance) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "name", before.Name, after.Name)
	addAuditTransition(changes, "projectId", auditUUID(before.ProjectID), auditUUID(after.ProjectID))
	addAuditTransition(changes, "environment", before.Environment, after.Environment)
	addAuditTransition(changes, "labels", auditJSON(before.Labels), auditJSON(after.Labels))
	addAuditTransition(changes, "autoRestart", before.AutoRestart, after.AutoRestart)
	return changes
}

func registryAuditChanges(before, after domain.Registry, input registryRequest) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "name", before.Name, after.Name)
	addAuditTransition(changes, "endpoint", auditURL(before.URL), auditURL(after.URL))
	if before.URL != after.URL && auditURL(before.URL) == auditURL(after.URL) {
		changes["endpointChanged"] = true
	}
	addAuditTransition(changes, "username", before.Username, after.Username)
	addAuditTransition(changes, "authenticationConfigured", before.HasPassword, after.HasPassword)
	addAuditTransition(changes, "caCertificateConfigured", before.HasCACertificate, after.HasCACertificate)
	if input.Password != "" {
		changes["passwordChanged"] = true
	}
	if input.CACertificate != "" {
		changes["caCertificateChanged"] = true
	}
	return changes
}

func webhookAuditChanges(before, after domain.Webhook, input webhookRequest) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "name", before.Name, after.Name)
	addAuditTransition(changes, "endpoint", auditURL(before.URL), auditURL(after.URL))
	if before.URL != after.URL && auditURL(before.URL) == auditURL(after.URL) {
		changes["endpointChanged"] = true
	}
	addAuditTransition(changes, "events", auditJSON(before.Events), auditJSON(after.Events))
	addAuditTransition(changes, "enabled", before.Enabled, after.Enabled)
	addAuditTransition(changes, "signingConfigured", before.HasSecret, after.HasSecret)
	if input.Secret != "" {
		changes["secretChanged"] = true
	}
	return changes
}

func settingAuditChanges(key string, before, after json.RawMessage) map[string]any {
	if key != "monitoring" && key != "uploads" && key != "timezone" {
		return map[string]any{"valueChanged": true}
	}
	changes := map[string]any{}
	addAuditTransition(changes, "value", auditJSON(before), auditJSON(after))
	return changes
}
