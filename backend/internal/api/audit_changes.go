package api

import (
	"encoding/json"
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
	addAuditTransition(changes, "purpose", before.Purpose, after.Purpose)
	addAuditTransition(changes, "owner", before.Owner, after.Owner)
	addAuditTransition(changes, "expiresAt", before.ExpiresAt, after.ExpiresAt)
	addAuditTransition(changes, "labels", auditJSON(before.Labels), auditJSON(after.Labels))
	return changes
}

func instanceReconfigureAuditChanges(before domain.Instance, cpu float64, memoryBytes, diskBytes int64,
	extraEnvironment map[string]string, autoRestart *bool) map[string]any {
	changes := map[string]any{}
	addAuditTransition(changes, "cpu", before.CPU, cpu)
	addAuditTransition(changes, "memoryBytes", before.MemoryBytes, memoryBytes)
	addAuditTransition(changes, "reservedDiskBytes", before.ReservedDiskBytes, diskBytes)
	if autoRestart != nil {
		addAuditTransition(changes, "autoRestart", before.AutoRestart, *autoRestart)
	}
	var configuration struct {
		ExtraEnvironment map[string]string `json:"extraEnvironment"`
	}
	if json.Unmarshal(before.Configuration, &configuration) != nil || !reflect.DeepEqual(configuration.ExtraEnvironment, extraEnvironment) {
		changes["environmentConfigurationChanged"] = true
	}
	return changes
}
