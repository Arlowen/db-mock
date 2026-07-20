package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/pika/db-mock/internal/domain"
)

const (
	AlertHostOffline          = "host_offline"
	AlertSSHCredentialInvalid = "ssh_credential_invalid"
	AlertContainerExited      = "container_exited"
	AlertContainerUnhealthy   = "container_unhealthy"
	AlertRestartFailed        = "restart_failed"
	AlertDiskWarning          = "disk_warning"
	AlertDiskCritical         = "disk_critical"
	AlertUpgradeFailed        = "upgrade_failed"
)

type MonitoringAlerts struct {
	HostOffline          bool `json:"hostOffline"`
	SSHCredentialInvalid bool `json:"sshCredentialInvalid"`
	ContainerExited      bool `json:"containerExited"`
	ContainerUnhealthy   bool `json:"containerUnhealthy"`
	RestartFailed        bool `json:"restartFailed"`
	DiskWarning          bool `json:"diskWarning"`
	DiskCritical         bool `json:"diskCritical"`
	UpgradeFailed        bool `json:"upgradeFailed"`
}

type MonitoringPolicy struct {
	IntervalSeconds     int              `json:"intervalSeconds"`
	RetentionDays       int              `json:"retentionDays"`
	DiskWarningPercent  float64          `json:"diskWarningPercent"`
	DiskCriticalPercent float64          `json:"diskCriticalPercent"`
	Alerts              MonitoringAlerts `json:"alerts"`
}

func DefaultMonitoringPolicy(intervalSeconds, retentionDays int) MonitoringPolicy {
	if intervalSeconds < 5 || intervalSeconds > 3600 {
		intervalSeconds = 30
	}
	if retentionDays < 1 || retentionDays > 365 {
		retentionDays = 7
	}
	return MonitoringPolicy{
		IntervalSeconds:     intervalSeconds,
		RetentionDays:       retentionDays,
		DiskWarningPercent:  80,
		DiskCriticalPercent: 90,
		Alerts: MonitoringAlerts{
			HostOffline:          true,
			SSHCredentialInvalid: true,
			ContainerExited:      true,
			ContainerUnhealthy:   true,
			RestartFailed:        true,
			DiskWarning:          true,
			DiskCritical:         true,
			UpgradeFailed:        true,
		},
	}
}

func DecodeMonitoringPolicy(raw json.RawMessage, defaults MonitoringPolicy) (MonitoringPolicy, error) {
	policy := defaults
	if len(bytes.TrimSpace(raw)) == 0 {
		return policy, validateMonitoringPolicy(policy)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return defaults, fmt.Errorf("%w: invalid monitoring policy: %v", domain.ErrInvalid, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return defaults, fmt.Errorf("%w: monitoring policy must contain one JSON object", domain.ErrInvalid)
	}
	if err := validateMonitoringPolicy(policy); err != nil {
		return defaults, err
	}
	return policy, nil
}

func NormalizeMonitoringPolicy(raw json.RawMessage) (json.RawMessage, error) {
	policy, err := DecodeMonitoringPolicy(raw, DefaultMonitoringPolicy(30, 7))
	if err != nil {
		return nil, err
	}
	result, err := json.Marshal(policy)
	if err != nil {
		return nil, fmt.Errorf("marshal monitoring policy: %w", err)
	}
	return result, nil
}

func validateMonitoringPolicy(policy MonitoringPolicy) error {
	switch {
	case policy.IntervalSeconds < 5 || policy.IntervalSeconds > 3600:
		return fmt.Errorf("%w: monitoring interval must be between 5 and 3600 seconds", domain.ErrInvalid)
	case policy.RetentionDays < 1 || policy.RetentionDays > 365:
		return fmt.Errorf("%w: metric retention must be between 1 and 365 days", domain.ErrInvalid)
	case policy.DiskWarningPercent < 1 || policy.DiskWarningPercent >= 100:
		return fmt.Errorf("%w: disk warning threshold must be at least 1 and below 100 percent", domain.ErrInvalid)
	case policy.DiskCriticalPercent <= policy.DiskWarningPercent || policy.DiskCriticalPercent > 100:
		return fmt.Errorf("%w: disk critical threshold must be above the warning threshold and no more than 100 percent", domain.ErrInvalid)
	default:
		return nil
	}
}

func (policy MonitoringPolicy) AlertEnabled(alertType string) bool {
	switch alertType {
	case AlertHostOffline:
		return policy.Alerts.HostOffline
	case AlertSSHCredentialInvalid:
		return policy.Alerts.SSHCredentialInvalid
	case AlertContainerExited:
		return policy.Alerts.ContainerExited
	case AlertContainerUnhealthy:
		return policy.Alerts.ContainerUnhealthy
	case AlertRestartFailed:
		return policy.Alerts.RestartFailed
	case AlertDiskWarning:
		return policy.Alerts.DiskWarning
	case AlertDiskCritical:
		return policy.Alerts.DiskCritical
	case AlertUpgradeFailed:
		return policy.Alerts.UpgradeFailed
	default:
		return false
	}
}
