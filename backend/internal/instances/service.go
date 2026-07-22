package instances

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
	platformsettings "github.com/pika/db-mock/internal/settings"
	"github.com/pika/db-mock/internal/store"
	"github.com/pika/db-mock/internal/tasks"
	"github.com/pika/db-mock/internal/templates"
)

type Service struct {
	store  *store.Store
	vault  *appcrypto.Vault
	docker *hostops.Docker
	tasks  *tasks.Manager
}

type CreateRequest struct {
	Name              string            `json:"name"`
	ProjectID         *uuid.UUID        `json:"projectId"`
	HostID            *uuid.UUID        `json:"hostId"`
	TemplateVersionID uuid.UUID         `json:"templateVersionId"`
	Environment       string            `json:"environment"`
	Labels            map[string]string `json:"labels"`
	AutoRestart       *bool             `json:"autoRestart"`
	CPU               float64           `json:"cpu"`
	MemoryBytes       int64             `json:"memoryBytes"`
	DiskBytes         int64             `json:"diskBytes"`
	HostPort          int               `json:"hostPort"`
	BindAddress       string            `json:"bindAddress"`
	Username          string            `json:"username"`
	Password          string            `json:"password"`
	DatabaseName      string            `json:"databaseName"`
	ExtraEnvironment  map[string]string `json:"extraEnvironment"`
	ImageArtifactID   *uuid.UUID        `json:"imageArtifactId"`
	RegistryID        *uuid.UUID        `json:"registryId"`
}

type ActionRequest struct {
	NewTemplateVersionID *uuid.UUID
	ImageSource          string
	ImageArtifactID      *uuid.UUID
	RegistryID           *uuid.UUID
	CPU                  float64
	MemoryBytes          int64
	DiskBytes            int64
	ExtraEnvironment     map[string]string
	AutoRestart          *bool
}

type ActionPayload struct {
	InstanceID                    uuid.UUID  `json:"instanceId"`
	OperationID                   *uuid.UUID `json:"operationId,omitempty"`
	ReuseRollbackSnapshot         bool       `json:"reuseRollbackSnapshot,omitempty"`
	NewTemplateVersionID          *uuid.UUID `json:"newTemplateVersionId,omitempty"`
	BackupID                      *uuid.UUID `json:"backupId,omitempty"`
	BackupPolicyID                *uuid.UUID `json:"backupPolicyId,omitempty"`
	ScheduledFor                  *time.Time `json:"scheduledFor,omitempty"`
	PreviousBackupStatus          string     `json:"previousBackupStatus,omitempty"`
	ImageSource                   string     `json:"imageSource,omitempty"`
	ImageArtifactID               *uuid.UUID `json:"imageArtifactId,omitempty"`
	RegistryID                    *uuid.UUID `json:"registryId,omitempty"`
	PreviousStatus                string     `json:"previousStatus,omitempty"`
	PreviousDesiredState          string     `json:"previousDesiredState,omitempty"`
	TargetCPU                     float64    `json:"targetCpu,omitempty"`
	TargetMemoryBytes             int64      `json:"targetMemoryBytes,omitempty"`
	TargetDiskBytes               int64      `json:"targetDiskBytes,omitempty"`
	EncryptedTargetConfig         string     `json:"encryptedTargetConfig,omitempty"`
	PreviousCPU                   float64    `json:"previousCpu,omitempty"`
	PreviousMemoryBytes           int64      `json:"previousMemoryBytes,omitempty"`
	PreviousDiskBytes             int64      `json:"previousDiskBytes,omitempty"`
	EncryptedPreviousConfig       string     `json:"encryptedPreviousConfig,omitempty"`
	TargetAutoRestart             *bool      `json:"targetAutoRestart,omitempty"`
	PreviousAutoRestart           *bool      `json:"previousAutoRestart,omitempty"`
	PreviousBackupPolicyEnabled   *bool      `json:"previousBackupPolicyEnabled,omitempty"`
	PreviousBackupPolicyNextRunAt *time.Time `json:"previousBackupPolicyNextRunAt,omitempty"`
}

type instanceConfiguration struct {
	ExtraEnvironment map[string]string `json:"extraEnvironment,omitempty"`
	ImageArtifactID  *uuid.UUID        `json:"imageArtifactId"`
	RegistryID       *uuid.UUID        `json:"registryId"`
}

type instanceStateTarget struct {
	Status  string
	Desired string
	Message string
}

func NewService(target *store.Store, vault *appcrypto.Vault, docker *hostops.Docker, manager *tasks.Manager) *Service {
	service := &Service{store: target, vault: vault, docker: docker, tasks: manager}
	manager.Register("instance.create", service.handleCreate)
	manager.Register("instance.start", service.handleStart)
	manager.Register("instance.stop", service.handleStop)
	manager.Register("instance.restart", service.handleRestart)
	manager.Register("instance.delete", service.handleDelete)
	manager.Register("instance.upgrade", service.handleUpgrade)
	manager.Register("instance.reconfigure", service.handleReconfigure)
	manager.Register("instance.backup", service.handleBackupCreate)
	manager.Register("instance.restore", service.handleBackupRestore)
	manager.Register("instance.backup.delete", service.handleBackupDelete)
	for _, kind := range []string{"instance.create", "instance.start", "instance.stop", "instance.restart",
		"instance.delete", "instance.upgrade", "instance.reconfigure", "instance.backup", "instance.restore",
		"instance.backup.delete"} {
		manager.RegisterCancellation(kind, service.prepareQueuedTaskCancellation)
	}
	return service
}

func (s *Service) prepareQueuedTaskCancellation(ctx context.Context, task domain.Task) (*store.QueuedTaskRecovery, error) {
	var payload ActionPayload
	if err := tasks.DecodePayload(task, &payload); err != nil {
		return nil, err
	}
	instance, err := s.store.GetInstance(ctx, payload.InstanceID)
	if err != nil {
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	stable := upgradeStableState(previousStatus, previousDesired)
	recovery := store.QueuedTaskRecovery{InstanceID: &payload.InstanceID,
		InstanceStatus: stable.Status, InstanceDesiredState: stable.Desired}
	if payload.OperationID != nil {
		recovery.PreserveResources = true
		return &recovery, nil
	}

	switch task.Kind {
	case "instance.create":
		recovery.InstanceStatus = "failed"
		recovery.InstanceDesiredState = ""
		recovery.InstanceStatusMessage = "Instance creation was canceled before the database was started"
	case "instance.start", "instance.stop", "instance.restart":
		recovery.InstanceStatus, recovery.InstanceDesiredState = previousStatus, previousDesired
	case "instance.delete":
		recovery.InstanceStatus, recovery.InstanceDesiredState = previousStatus, previousDesired
		if payload.PreviousBackupPolicyEnabled != nil {
			recovery.DeletePolicy = &store.BackupPolicyState{Enabled: *payload.PreviousBackupPolicyEnabled,
				NextRunAt: payload.PreviousBackupPolicyNextRunAt}
		}
	case "instance.upgrade":
	case "instance.reconfigure":
		previousConfiguration, openErr := s.openRuntimeConfiguration(instance.ID, payload.EncryptedPreviousConfig)
		if openErr != nil {
			return nil, openErr
		}
		_, previousAutoRestart := taskRestartPolicies(payload, instance)
		configuration := runtimeConfiguration(payload.PreviousCPU, payload.PreviousMemoryBytes,
			payload.PreviousDiskBytes, previousConfiguration, previousAutoRestart)
		recovery.RuntimeConfiguration = &configuration
	case "instance.backup":
		if payload.BackupID == nil {
			return nil, domain.ErrInvalid
		}
		recovery.BackupID = payload.BackupID
		recovery.BackupStatus = "failed"
		recovery.BackupStatusMessage = "Backup creation was canceled before the archive was created"
		recovery.BackupPolicyID = payload.BackupPolicyID
	case "instance.restore":
		if payload.BackupID == nil {
			return nil, domain.ErrInvalid
		}
		recovery.BackupID = payload.BackupID
		recovery.BackupStatus = "ready"
	case "instance.backup.delete":
		if payload.BackupID == nil {
			return nil, domain.ErrInvalid
		}
		recovery.InstanceStatus, recovery.InstanceDesiredState = instance.Status, instance.DesiredState
		recovery.BackupID = payload.BackupID
		recovery.BackupStatus = payload.PreviousBackupStatus
		if recovery.BackupStatus != "ready" && recovery.BackupStatus != "failed" {
			recovery.BackupStatus = "ready"
		}
	default:
		return nil, fmt.Errorf("%w: unknown instance task kind", domain.ErrInvalid)
	}
	return &recovery, nil
}

func deleteBackupPolicyState(payload ActionPayload) *store.BackupPolicyState {
	if payload.PreviousBackupPolicyEnabled == nil {
		return nil
	}
	return &store.BackupPolicyState{Enabled: *payload.PreviousBackupPolicyEnabled,
		NextRunAt: payload.PreviousBackupPolicyNextRunAt}
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, request CreateRequest) (domain.Instance, domain.Task, error) {
	if strings.TrimSpace(request.Name) == "" {
		return domain.Instance{}, domain.Task{}, domain.ErrInvalid
	}
	if request.ImageArtifactID != nil && request.RegistryID != nil {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: choose either an offline image or a registry", domain.ErrInvalid)
	}
	if request.Environment != "" && request.Environment != "development" && request.Environment != "testing" && request.Environment != "staging" && request.Environment != "production" {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: unsupported environment", domain.ErrInvalid)
	}
	if request.BindAddress != "" {
		address := net.ParseIP(request.BindAddress)
		if address == nil || address.To4() == nil {
			return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: bindAddress must be an IPv4 address", domain.ErrInvalid)
		}
	}
	template, version, err := s.store.GetTemplateVersion(ctx, request.TemplateVersionID)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	if !version.Selectable {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: template version is not available for new instances", domain.ErrConflict)
	}
	if request.CPU == 0 {
		request.CPU = version.MinCPU
	}
	if request.MemoryBytes == 0 {
		request.MemoryBytes = version.MinMemoryBytes
	}
	if request.DiskBytes == 0 {
		request.DiskBytes = version.MinDiskBytes
	}
	if request.CPU < version.MinCPU || request.MemoryBytes < version.MinMemoryBytes || request.DiskBytes < version.MinDiskBytes {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: resources are below template minimum", domain.ErrInvalid)
	}
	host, hostPort, err := s.selectHost(ctx, request.HostID, version, request.CPU, request.MemoryBytes, request.DiskBytes, request.HostPort)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	request.HostPort = hostPort
	if request.ImageArtifactID != nil {
		artifact, getErr := s.store.GetImageArtifact(ctx, *request.ImageArtifactID)
		if getErr != nil {
			return domain.Instance{}, domain.Task{}, getErr
		}
		if !artifactSupportsVersion(artifact, host, version) {
			return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: offline image is incompatible with the selected template or host", domain.ErrConflict)
		}
	}
	if request.RegistryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *request.RegistryID)
		if getErr != nil {
			return domain.Instance{}, domain.Task{}, getErr
		}
		if getErr = validateRegistryTemplateSource(registry, version); getErr != nil {
			return domain.Instance{}, domain.Task{}, getErr
		}
	}
	manifest, err := templates.ParseManifest(version.Manifest)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	if request.Username == "" {
		request.Username = manifest.Username
	}
	if request.DatabaseName == "" {
		request.DatabaseName = manifest.Database
	}
	if request.Password == "" {
		request.Password = generatePassword()
	}
	if strings.ContainsAny(request.Password, "\r\n\x00") {
		return domain.Instance{}, domain.Task{}, domain.ErrInvalid
	}
	if request.Environment == "" {
		request.Environment = "development"
	}
	if request.BindAddress == "" {
		request.BindAddress = "0.0.0.0"
	}
	autoRestart := host.AutoRestartDefault
	if request.AutoRestart != nil {
		autoRestart = *request.AutoRestart
	}
	instanceID := uuid.New()
	encrypted, err := s.vault.Seal([]byte(request.Password), "instance:"+instanceID.String())
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	labels, _ := json.Marshal(request.Labels)
	configuration, _ := json.Marshal(instanceConfiguration{ExtraEnvironment: request.ExtraEnvironment,
		ImageArtifactID: request.ImageArtifactID, RegistryID: request.RegistryID})
	short := strings.ReplaceAll(instanceID.String(), "-", "")
	instance, task, err := s.store.CreateInstanceTask(ctx, store.InstanceInput{ID: instanceID, Name: request.Name, ProjectID: request.ProjectID,
		HostID: host.ID, TemplateVersionID: version.ID, Environment: request.Environment, Labels: labels, AutoRestart: autoRestart,
		CPU: request.CPU, MemoryBytes: request.MemoryBytes, ReservedDiskBytes: request.DiskBytes, HostPort: request.HostPort,
		ContainerPort: version.DefaultPort, BindAddress: request.BindAddress, DatabaseUsername: request.Username,
		EncryptedPassword: encrypted, DatabaseName: request.DatabaseName, ComposeProject: "dbmock_" + short,
		RemoteDirectory: path.Join(host.DataRoot, "instances", instanceID.String()), Configuration: configuration}, store.TaskInput{
		RequestedBy: userID, Payload: ActionPayload{InstanceID: instanceID, ImageArtifactID: request.ImageArtifactID,
			RegistryID: request.RegistryID},
	})
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	s.tasks.Wake()
	_ = template
	return instance, task, nil
}

func (s *Service) Action(ctx context.Context, userID, instanceID uuid.UUID, action string, request ActionRequest) (domain.Task, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.Task{}, err
	}
	if err = validateInstanceAction(instance.Status, action, request.NewTemplateVersionID); err != nil {
		return domain.Task{}, err
	}
	if err = validateInstanceActionRequest(action, request); err != nil {
		return domain.Task{}, err
	}
	if action == "delete" {
		backups, backupErr := s.store.ListInstanceBackups(ctx, instance.ID)
		if backupErr != nil {
			return domain.Task{}, backupErr
		}
		if len(backups) > 0 {
			return domain.Task{}, fmt.Errorf("%w: delete instance backups before deleting the instance", domain.ErrConflict)
		}
	}
	payload := ActionPayload{InstanceID: instance.ID, NewTemplateVersionID: request.NewTemplateVersionID,
		PreviousStatus: instance.Status, PreviousDesiredState: instance.DesiredState}
	if action == "reconfigure" {
		template, version, getErr := s.store.GetTemplateVersion(ctx, instance.TemplateVersionID)
		if getErr != nil {
			return domain.Task{}, getErr
		}
		target, configuration, prepareErr := prepareRuntimeConfiguration(template, version, instance, request)
		if prepareErr != nil {
			return domain.Task{}, prepareErr
		}
		encryptedTarget, sealErr := s.vault.Seal(configuration, runtimeConfigurationContext(instance.ID))
		if sealErr != nil {
			return domain.Task{}, sealErr
		}
		encryptedPrevious, sealErr := s.vault.Seal(instance.Configuration, runtimeConfigurationContext(instance.ID))
		if sealErr != nil {
			return domain.Task{}, sealErr
		}
		payload.TargetCPU, payload.TargetMemoryBytes, payload.TargetDiskBytes = target.CPU, target.MemoryBytes, target.ReservedDiskBytes
		payload.TargetAutoRestart = boolValue(target.AutoRestart)
		payload.EncryptedTargetConfig = encryptedTarget
		payload.PreviousCPU, payload.PreviousMemoryBytes, payload.PreviousDiskBytes = instance.CPU, instance.MemoryBytes, instance.ReservedDiskBytes
		payload.PreviousAutoRestart = boolValue(instance.AutoRestart)
		payload.EncryptedPreviousConfig = encryptedPrevious
		task, createErr := s.store.CreateInstanceReconfigureTask(ctx, store.TaskInput{Kind: "instance.reconfigure",
			ResourceType: "instance", ResourceID: &instance.ID, RequestedBy: userID, HostID: &instance.HostID,
			Payload: payload}, instance.ID, instance.Status, store.InstanceRuntimeConfiguration{CPU: target.CPU,
			MemoryBytes: target.MemoryBytes, ReservedDiskBytes: target.ReservedDiskBytes, Configuration: configuration,
			AutoRestart: target.AutoRestart})
		if createErr == nil {
			s.tasks.Wake()
		}
		return task, createErr
	}
	if action == "upgrade" {
		var target domain.TemplateVersion
		payload.ImageSource, payload.ImageArtifactID, payload.RegistryID, target, err = s.prepareUpgrade(ctx, instance, request)
		if err != nil {
			return domain.Task{}, err
		}
		payload.NewTemplateVersionID = &target.ID
	}
	operationStatus := instanceOperationStatus(action)
	task, err := s.store.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance." + action, ResourceType: "instance", ResourceID: &instance.ID,
		RequestedBy: userID, HostID: &instance.HostID, Payload: payload}, instance.ID, instance.Status, operationStatus)
	if err == nil {
		s.tasks.Wake()
	}
	return task, err
}

func validateInstanceActionRequest(action string, request ActionRequest) error {
	if action != "upgrade" && (request.NewTemplateVersionID != nil || request.ImageSource != "" ||
		request.ImageArtifactID != nil || request.RegistryID != nil) {
		return fmt.Errorf("%w: image source and template version are only valid for instance upgrades", domain.ErrInvalid)
	}
	if action != "reconfigure" && (request.CPU != 0 || request.MemoryBytes != 0 || request.DiskBytes != 0 ||
		request.ExtraEnvironment != nil || request.AutoRestart != nil) {
		return fmt.Errorf("%w: runtime configuration is only valid for instance reconfiguration", domain.ErrInvalid)
	}
	return nil
}

func prepareRuntimeConfiguration(template domain.Template, version domain.TemplateVersion, instance domain.Instance, request ActionRequest) (domain.Instance, json.RawMessage, error) {
	if request.CPU <= 0 || request.MemoryBytes <= 0 || request.DiskBytes <= 0 {
		return domain.Instance{}, nil, fmt.Errorf("%w: positive CPU, memory, and disk reservations are required", domain.ErrInvalid)
	}
	if request.ExtraEnvironment == nil {
		return domain.Instance{}, nil, fmt.Errorf("%w: extra environment must be a JSON object", domain.ErrInvalid)
	}
	if request.CPU < version.MinCPU || request.MemoryBytes < version.MinMemoryBytes || request.DiskBytes < version.MinDiskBytes {
		return domain.Instance{}, nil, fmt.Errorf("%w: resources are below template minimum", domain.ErrInvalid)
	}
	var current instanceConfiguration
	if err := json.Unmarshal(instance.Configuration, &current); err != nil {
		return domain.Instance{}, nil, fmt.Errorf("%w: instance configuration is not valid JSON", domain.ErrInvalid)
	}
	targetAutoRestart := instance.AutoRestart
	if request.AutoRestart != nil {
		targetAutoRestart = *request.AutoRestart
	}
	if request.CPU == instance.CPU && request.MemoryBytes == instance.MemoryBytes && request.DiskBytes == instance.ReservedDiskBytes &&
		targetAutoRestart == instance.AutoRestart && maps.Equal(request.ExtraEnvironment, current.ExtraEnvironment) {
		return domain.Instance{}, nil, fmt.Errorf("%w: runtime configuration has not changed", domain.ErrConflict)
	}
	current.ExtraEnvironment = request.ExtraEnvironment
	configuration, err := json.Marshal(current)
	if err != nil {
		return domain.Instance{}, nil, err
	}
	target := instance
	target.CPU, target.MemoryBytes, target.ReservedDiskBytes = request.CPU, request.MemoryBytes, request.DiskBytes
	target.AutoRestart = targetAutoRestart
	target.Configuration = configuration
	if _, err = templates.RenderCompose(template, version, target, current.ExtraEnvironment); err != nil {
		return domain.Instance{}, nil, fmt.Errorf("%w: %v", domain.ErrInvalid, err)
	}
	return target, configuration, nil
}

func normalizeBackupName(value string, now time.Time) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "Backup " + now.UTC().Format("2006-01-02 15:04:05 UTC")
	}
	if len([]rune(value)) > 120 || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("%w: backup name must be at most 120 characters on one line", domain.ErrInvalid)
	}
	return value, nil
}

func validateBackupSourceStatus(status string) error {
	if status != "running" && status != "stopped" {
		return fmt.Errorf("%w: backups can only be created from a running or stopped instance", domain.ErrConflict)
	}
	return nil
}

func validateRestoreSourceStatus(status string) error {
	if status != "running" && status != "stopped" && status != "degraded" && status != "failed" {
		return fmt.Errorf("%w: backup restore is not allowed for the current instance status", domain.ErrConflict)
	}
	return nil
}

func (s *Service) CreateBackup(ctx context.Context, userID, instanceID uuid.UUID, name string) (domain.InstanceBackup, domain.Task, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	if err = validateBackupSourceStatus(instance.Status); err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	name, err = normalizeBackupName(name, time.Now())
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	host, err := s.store.GetHost(ctx, instance.HostID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	backupID := uuid.New()
	remotePath, err := s.docker.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	payload := ActionPayload{InstanceID: instance.ID, BackupID: &backupID, PreviousStatus: instance.Status,
		PreviousDesiredState: instance.DesiredState}
	resourceID := instance.ID
	backup, task, err := s.store.CreateInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &instance.HostID,
		Payload: payload}, domain.InstanceBackup{ID: backupID, InstanceID: instance.ID, Name: name,
		CreationType: "manual", RemotePath: remotePath, CreatedBy: userID}, instance.Status)
	if err != nil {
		return backup, task, err
	}
	s.tasks.Wake()
	if fresh, getErr := s.store.GetInstanceBackup(ctx, backup.ID); getErr == nil {
		backup = fresh
	}
	return backup, task, nil
}

func (s *Service) RestoreBackup(ctx context.Context, userID, instanceID, backupID uuid.UUID) (domain.InstanceBackup, domain.Task, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	if err = validateRestoreSourceStatus(instance.Status); err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	backup, err := s.store.GetInstanceBackup(ctx, backupID)
	if err != nil || backup.InstanceID != instance.ID {
		if err == nil {
			err = domain.ErrNotFound
		}
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	payload := ActionPayload{InstanceID: instance.ID, BackupID: &backup.ID, PreviousBackupStatus: backup.Status,
		PreviousStatus: instance.Status, PreviousDesiredState: instance.DesiredState}
	resourceID := instance.ID
	backup, task, err := s.store.CreateInstanceRestoreTask(ctx, store.TaskInput{Kind: "instance.restore",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: userID, HostID: &instance.HostID,
		Payload: payload}, instance.ID, backup.ID, instance.Status)
	if err == nil {
		s.tasks.Wake()
	}
	return backup, task, err
}

func (s *Service) DeleteBackup(ctx context.Context, userID, instanceID, backupID uuid.UUID) (domain.InstanceBackup, domain.Task, error) {
	backup, err := s.store.GetInstanceBackup(ctx, backupID)
	if err != nil || backup.InstanceID != instanceID {
		if err == nil {
			err = domain.ErrNotFound
		}
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	payload := ActionPayload{InstanceID: instanceID, BackupID: &backup.ID, PreviousBackupStatus: backup.Status}
	resourceID := backup.ID
	backup, task, err := s.store.CreateInstanceBackupDeleteTask(ctx, store.TaskInput{Kind: "instance.backup.delete",
		ResourceType: "backup", ResourceID: &resourceID, RequestedBy: userID, HostID: &backup.HostID,
		Payload: payload}, backup.ID)
	if err == nil {
		s.tasks.Wake()
	}
	return backup, task, err
}

func validateUpgradeImageSelection(source string, artifactID, registryID *uuid.UUID) error {
	switch source {
	case "public":
		if artifactID != nil || registryID != nil {
			return fmt.Errorf("%w: direct pull cannot include an offline image or registry", domain.ErrInvalid)
		}
	case "offline":
		if artifactID == nil || registryID != nil {
			return fmt.Errorf("%w: offline upgrade requires exactly one offline image", domain.ErrInvalid)
		}
	case "registry":
		if registryID == nil || artifactID != nil {
			return fmt.Errorf("%w: registry upgrade requires exactly one configured registry", domain.ErrInvalid)
		}
	default:
		return fmt.Errorf("%w: upgrade image source must be public, registry, or offline", domain.ErrInvalid)
	}
	return nil
}

func artifactSupportsVersion(artifact domain.ImageArtifact, host domain.Host, version domain.TemplateVersion) bool {
	if artifact.Status != "ready" || !supports(artifact.Architectures, host.Architecture) {
		return false
	}
	references, err := templates.RequiredImageReferences(version)
	if err != nil {
		return false
	}
	for _, reference := range references {
		if !contains(artifact.ImageRefs, reference) {
			return false
		}
	}
	return true
}

func (s *Service) prepareUpgrade(ctx context.Context, instance domain.Instance, request ActionRequest) (string, *uuid.UUID, *uuid.UUID, domain.TemplateVersion, error) {
	if request.NewTemplateVersionID == nil {
		return "", nil, nil, domain.TemplateVersion{}, domain.ErrInvalid
	}
	_, currentVersion, err := s.store.GetTemplateVersion(ctx, instance.TemplateVersionID)
	if err != nil {
		return "", nil, nil, domain.TemplateVersion{}, err
	}
	_, targetVersion, err := s.store.GetTemplateVersion(ctx, *request.NewTemplateVersionID)
	if err != nil {
		return "", nil, nil, domain.TemplateVersion{}, err
	}
	if targetVersion.ID == currentVersion.ID {
		return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: select a different template version", domain.ErrConflict)
	}
	if !targetVersion.Selectable {
		return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: template version is not available for upgrades", domain.ErrConflict)
	}
	if targetVersion.TemplateID != currentVersion.TemplateID {
		return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: upgrade version belongs to a different database template", domain.ErrConflict)
	}
	targetManifest, manifestErr := templates.ParseManifest(targetVersion.Manifest)
	if manifestErr != nil {
		return "", nil, nil, domain.TemplateVersion{}, manifestErr
	}
	if major(currentVersion.Version) != major(targetVersion.Version) && targetManifest.UpgradeScript == "" {
		return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: major version upgrades require a template-specific migration", domain.ErrConflict)
	}
	host, err := s.store.GetHost(ctx, instance.HostID)
	if err != nil {
		return "", nil, nil, domain.TemplateVersion{}, err
	}
	if !supports(targetVersion.Architectures, host.Architecture) {
		return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: upgrade version is incompatible with the instance host architecture", domain.ErrConflict)
	}

	source, artifactID, registryID := request.ImageSource, request.ImageArtifactID, request.RegistryID
	if source == "" {
		var configuration instanceConfiguration
		_ = json.Unmarshal(instance.Configuration, &configuration)
		if configuration.ImageArtifactID != nil {
			artifact, artifactErr := s.store.GetImageArtifact(ctx, *configuration.ImageArtifactID)
			if artifactErr == nil && artifactSupportsVersion(artifact, host, targetVersion) {
				source, artifactID = "offline", configuration.ImageArtifactID
			}
		}
		if source == "" && configuration.RegistryID != nil {
			registry, registryErr := s.store.GetRegistry(ctx, *configuration.RegistryID)
			if registryErr == nil && validateRegistryTemplateSource(registry, targetVersion) == nil {
				source, registryID = "registry", configuration.RegistryID
			}
		}
		if source == "" {
			source = "public"
		}
	}
	if err = validateUpgradeImageSelection(source, artifactID, registryID); err != nil {
		return "", nil, nil, domain.TemplateVersion{}, err
	}
	if artifactID != nil {
		artifact, getErr := s.store.GetImageArtifact(ctx, *artifactID)
		if getErr != nil {
			return "", nil, nil, domain.TemplateVersion{}, getErr
		}
		if !artifactSupportsVersion(artifact, host, targetVersion) {
			return "", nil, nil, domain.TemplateVersion{}, fmt.Errorf("%w: offline image is incompatible with the upgrade version or instance host", domain.ErrConflict)
		}
	}
	if registryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *registryID)
		if getErr != nil {
			return "", nil, nil, domain.TemplateVersion{}, getErr
		}
		if getErr = validateRegistryTemplateSource(registry, targetVersion); getErr != nil {
			return "", nil, nil, domain.TemplateVersion{}, getErr
		}
	}
	return source, artifactID, registryID, targetVersion, nil
}

func instanceOperationStatus(action string) string {
	switch action {
	case "start":
		return "starting"
	case "stop":
		return "stopping"
	case "restart":
		return "restarting"
	case "delete":
		return "deleting"
	case "upgrade":
		return "upgrading"
	case "reconfigure":
		return "reconfiguring"
	case "backup":
		return "backing_up"
	case "restore":
		return "restoring"
	default:
		return ""
	}
}

func instanceActionFailureState(action, previousStatus, previousDesired string) instanceStateTarget {
	target := instanceStateTarget{Status: previousStatus, Desired: previousDesired, Message: "Instance operation failed; retry the operation or inspect its task log"}
	switch action {
	case "start", "delete":
		target.Status = "failed"
	case "stop", "restart":
		target.Status = "degraded"
	}
	return target
}

func upgradeStableState(previousStatus, previousDesired string) instanceStateTarget {
	if previousDesired == "stopped" || previousStatus == "stopped" {
		return instanceStateTarget{Status: "stopped", Desired: "stopped"}
	}
	return instanceStateTarget{Status: "running", Desired: "running"}
}

func previousInstanceState(payload ActionPayload, instance domain.Instance) (string, string) {
	status, desired := payload.PreviousStatus, payload.PreviousDesiredState
	if desired == "" {
		desired = instance.DesiredState
	}
	if status == "" {
		if desired == "stopped" {
			status = "stopped"
		} else {
			status = "running"
		}
	}
	return status, desired
}

func rollbackOperation(payload ActionPayload, task domain.Task) (uuid.UUID, bool) {
	if payload.OperationID == nil || *payload.OperationID == uuid.Nil {
		return task.ID, false
	}
	return *payload.OperationID, payload.ReuseRollbackSnapshot
}

func currentOrPreviousInstanceState(payload ActionPayload, instance domain.Instance) (string, string) {
	switch instance.Status {
	case "running", "stopped", "degraded", "failed":
		return instance.Status, instance.DesiredState
	default:
		return previousInstanceState(payload, instance)
	}
}

func validateInstanceAction(status, action string, newVersion *uuid.UUID) error {
	allowedStatuses := map[string]map[string]bool{
		"start":       {"stopped": true, "failed": true},
		"stop":        {"running": true, "degraded": true},
		"restart":     {"running": true, "degraded": true},
		"delete":      {"running": true, "stopped": true, "degraded": true, "failed": true},
		"upgrade":     {"running": true, "stopped": true, "degraded": true},
		"reconfigure": {"running": true, "stopped": true, "degraded": true},
	}
	statuses, ok := allowedStatuses[action]
	if !ok {
		return domain.ErrInvalid
	}
	if action == "upgrade" && newVersion == nil {
		return domain.ErrInvalid
	}
	if !statuses[status] {
		return fmt.Errorf("%w: instance action is not allowed for the current status", domain.ErrConflict)
	}
	return nil
}

func (s *Service) Connection(ctx context.Context, id uuid.UUID) (domain.InstanceConnection, error) {
	instance, err := s.store.GetInstance(ctx, id)
	if err != nil {
		return domain.InstanceConnection{}, err
	}
	plain, err := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
	if err != nil {
		return domain.InstanceConnection{}, err
	}
	template, version, err := s.store.GetTemplateVersion(ctx, instance.TemplateVersionID)
	if err != nil {
		return domain.InstanceConnection{}, err
	}
	return templates.Connection(template, version, instance, instance.ConnectionAddress, string(plain)), nil
}

func (s *Service) selectHost(ctx context.Context, requested *uuid.UUID, version domain.TemplateVersion, cpu float64, memory, disk int64, port int) (domain.Host, int, error) {
	if requested != nil {
		host, err := s.store.GetHost(ctx, *requested)
		if err != nil {
			return domain.Host{}, 0, err
		}
		if host.Status != "online" || host.Maintenance {
			return domain.Host{}, 0, fmt.Errorf("%w: host is not available for deployments", domain.ErrConflict)
		}
		if !supports(version.Architectures, host.Architecture) {
			return domain.Host{}, 0, fmt.Errorf("%w: host architecture is incompatible", domain.ErrConflict)
		}
		reservation, err := s.store.HostReservations(ctx, host.ID)
		if err != nil {
			return domain.Host{}, 0, err
		}
		if !fitsHost(host, reservation, cpu, memory, disk) {
			return domain.Host{}, 0, fmt.Errorf("%w: host does not have enough available resources", domain.ErrConflict)
		}
		if !portAvailable(host, reservation, port) {
			return domain.Host{}, 0, fmt.Errorf("%w: requested port is not available on the selected host", domain.ErrConflict)
		}
		selectedPort, err := s.selectAvailablePort(ctx, host, reservation, port)
		if err != nil {
			return domain.Host{}, 0, err
		}
		return host, selectedPort, nil
	}
	hosts, err := s.store.ListHosts(ctx)
	if err != nil {
		return domain.Host{}, 0, err
	}
	type candidate struct {
		host        domain.Host
		reservation store.HostReservation
		score       float64
	}
	var candidates []candidate
	for _, host := range hosts {
		if host.Status != "online" || host.Maintenance || !supports(version.Architectures, host.Architecture) {
			continue
		}
		reservation, err := s.store.HostReservations(ctx, host.ID)
		if err != nil {
			continue
		}
		if !fitsHost(host, reservation, cpu, memory, disk) {
			continue
		}
		if !portAvailable(host, reservation, port) {
			continue
		}
		score := (host.CPUCount-reservation.CPU)/max(host.CPUCount, 1) + float64(host.MemoryBytes-reservation.Memory)/float64(maxInt(host.MemoryBytes, 1))
		candidates = append(candidates, candidate{host: host, reservation: reservation, score: score})
	}
	if len(candidates) == 0 {
		return domain.Host{}, 0, fmt.Errorf("%w: no compatible host has enough resources or the requested port is unavailable", domain.ErrConflict)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].score > candidates[j].score })
	var inspectErr error
	for _, candidate := range candidates {
		selectedPort, portErr := s.selectAvailablePort(ctx, candidate.host, candidate.reservation, port)
		if portErr == nil {
			return candidate.host, selectedPort, nil
		}
		if errors.Is(portErr, domain.ErrUnavailable) {
			inspectErr = portErr
		}
	}
	if inspectErr != nil {
		return domain.Host{}, 0, inspectErr
	}
	return domain.Host{}, 0, fmt.Errorf("%w: every compatible host has a conflicting TCP listener in its port pool", domain.ErrConflict)
}

func fitsHost(host domain.Host, reservation store.HostReservation, cpu float64, memory, disk int64) bool {
	return reservation.CPU+cpu <= host.CPUCount*.9 &&
		reservation.Memory+memory <= int64(float64(host.MemoryBytes)*.8) &&
		reservation.Disk+disk <= int64(float64(host.DiskFreeBytes)*.8)
}

func portAvailable(host domain.Host, reservation store.HostReservation, port int) bool {
	if port == 0 {
		for candidate := host.PortStart; candidate <= host.PortEnd; candidate++ {
			if _, used := reservation.Ports[candidate]; !used {
				return true
			}
		}
		return false
	}
	if port < host.PortStart || port > host.PortEnd {
		return false
	}
	_, used := reservation.Ports[port]
	return !used
}

func (s *Service) selectAvailablePort(ctx context.Context, host domain.Host, reservation store.HostReservation, requested int) (int, error) {
	listening, err := s.docker.ListeningTCPPorts(ctx, host)
	if err != nil {
		return 0, fmt.Errorf("%w: cannot inspect listening ports on host %q: %v", domain.ErrUnavailable, host.Name, err)
	}
	if selected, ok := chooseAvailablePort(host, reservation, listening, requested); ok {
		return selected, nil
	}
	if requested != 0 {
		return 0, fmt.Errorf("%w: port %d is outside the host pool, reserved, or already listening on host %q", domain.ErrConflict, requested, host.Name)
	}
	return 0, fmt.Errorf("%w: no unused TCP port remains in host %q pool %d-%d", domain.ErrConflict, host.Name, host.PortStart, host.PortEnd)
}

func chooseAvailablePort(host domain.Host, reservation store.HostReservation, listening map[int]struct{}, requested int) (int, bool) {
	if requested != 0 {
		if !portAvailable(host, reservation, requested) {
			return 0, false
		}
		_, used := listening[requested]
		return requested, !used
	}
	for candidate := host.PortStart; candidate <= host.PortEnd; candidate++ {
		if _, reserved := reservation.Ports[candidate]; reserved {
			continue
		}
		if _, used := listening[candidate]; used {
			continue
		}
		return candidate, true
	}
	return 0, false
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func normalizeRegistryHost(value string) string {
	value = strings.ToLower(strings.TrimSuffix(value, "/"))
	if value == "index.docker.io" || value == "registry-1.docker.io" {
		return "docker.io"
	}
	return value
}

func imageRegistryHost(reference string) string {
	reference = strings.TrimPrefix(strings.TrimSpace(reference), "docker://")
	parts := strings.Split(reference, "/")
	if len(parts) > 1 && (strings.Contains(parts[0], ".") || strings.Contains(parts[0], ":") || parts[0] == "localhost") {
		return normalizeRegistryHost(parts[0])
	}
	return "docker.io"
}

func validateRegistryImageSource(registry domain.Registry, imageReference string) error {
	parsed, err := url.Parse(registry.URL)
	if err != nil || parsed.Host == "" || normalizeRegistryHost(parsed.Host) != imageRegistryHost(imageReference) {
		return fmt.Errorf("%w: registry does not match the template image source", domain.ErrConflict)
	}
	if registry.Status == "offline" || registry.Status == "degraded" {
		return fmt.Errorf("%w: registry connection is not ready", domain.ErrConflict)
	}
	return nil
}

func validateRegistryTemplateSource(registry domain.Registry, version domain.TemplateVersion) error {
	references, err := templates.RequiredImageReferences(version)
	if err != nil {
		return err
	}
	for _, reference := range references {
		if err = validateRegistryImageSource(registry, reference); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) pullTemplateImages(ctx context.Context, host domain.Host, version domain.TemplateVersion) error {
	references, err := templates.RequiredImageReferences(version)
	if err != nil {
		return err
	}
	for _, reference := range references {
		if err = s.docker.PullImage(ctx, host, reference); err != nil {
			return fmt.Errorf("pull template image %s: %w", reference, err)
		}
	}
	return nil
}

func (s *Service) load(ctx context.Context, task domain.Task) (ActionPayload, domain.Instance, domain.Host, domain.Template, domain.TemplateVersion, error) {
	var payload ActionPayload
	if err := tasks.DecodePayload(task, &payload); err != nil {
		return payload, domain.Instance{}, domain.Host{}, domain.Template{}, domain.TemplateVersion{}, err
	}
	instance, err := s.store.GetInstance(ctx, payload.InstanceID)
	if err != nil {
		return payload, instance, domain.Host{}, domain.Template{}, domain.TemplateVersion{}, err
	}
	host, err := s.store.GetHost(ctx, instance.HostID)
	if err != nil {
		return payload, instance, host, domain.Template{}, domain.TemplateVersion{}, err
	}
	template, version, err := s.store.GetTemplateVersion(ctx, instance.TemplateVersionID)
	return payload, instance, host, template, version, err
}

func (s *Service) handleCreate(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	_, instance, host, template, version, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			message := err.Error()
			if errors.Is(err, tasks.ErrCanceled) {
				message = "Instance creation was canceled before the database was started"
			}
			recoveryCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, "failed", "", message)
		}
	}()
	if !version.Selectable {
		return nil, fmt.Errorf("%w: template version is not available for new instances", domain.ErrConflict)
	}
	if err = runtime.Stage(ctx, 5, "preflight", "Checking host and template", true); err != nil {
		return nil, err
	}
	probe, err := s.docker.Probe(ctx, host)
	if err != nil {
		return nil, err
	}
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		return nil, errors.New("docker engine and Compose v2 are required")
	}
	manifest, _ := templates.ParseManifest(version.Manifest)
	if err = runtime.Stage(ctx, 15, "tuning", "Applying required host settings", true); err != nil {
		return nil, err
	}
	if len(manifest.HostTuning) > 0 {
		if err = s.docker.ApplyTuning(ctx, host, manifest.HostTuning); err != nil {
			return nil, err
		}
	}
	var configuration instanceConfiguration
	_ = json.Unmarshal(instance.Configuration, &configuration)
	if err = runtime.Stage(ctx, 30, "image", "Preparing database image", true); err != nil {
		return nil, err
	}
	if configuration.RegistryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *configuration.RegistryID)
		if getErr != nil {
			return nil, getErr
		}
		if getErr = validateRegistryTemplateSource(registry, version); getErr != nil {
			return nil, getErr
		}
		password := ""
		if registry.EncryptedPassword != "" {
			plain, openErr := s.vault.Open(registry.EncryptedPassword, "registry:"+registry.ID.String()+":password")
			if openErr != nil {
				return nil, openErr
			}
			password = string(plain)
		}
		if registry.EncryptedCACertificate != "" {
			plain, openErr := s.vault.Open(registry.EncryptedCACertificate, "registry:"+registry.ID.String()+":ca")
			if openErr != nil {
				return nil, openErr
			}
			if err = s.docker.InstallRegistryCA(ctx, host, registry.URL, string(plain)); err != nil {
				return nil, err
			}
		}
		if err = s.docker.LoginRegistry(ctx, host, registry.URL, registry.Username, password); err != nil {
			return nil, err
		}
	}
	if configuration.ImageArtifactID != nil {
		artifact, getErr := s.store.GetImageArtifact(ctx, *configuration.ImageArtifactID)
		if getErr != nil {
			return nil, getErr
		}
		if !artifactSupportsVersion(artifact, host, version) {
			return nil, fmt.Errorf("%w: offline image is incompatible with the selected template or host", domain.ErrConflict)
		}
		err = s.docker.LoadImage(ctx, host, artifact.Path, func(done, total int64) {
			if total > 0 {
				_ = s.store.UpdateTask(context.Background(), task.ID, 30+int(done*20/total), "image", "Transferring offline image", true)
			}
		})
		if err == nil {
			markContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = s.store.MarkImageArtifactUsed(markContext, artifact.ID)
			cancel()
		}
	} else {
		err = s.pullTemplateImages(ctx, host, version)
	}
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 55, "render", "Rendering Compose project", true); err != nil {
		return nil, err
	}
	plain, err := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
	if err != nil {
		return nil, err
	}
	compose, err := templates.RenderCompose(template, version, instance, configuration.ExtraEnvironment)
	if err != nil {
		return nil, err
	}
	env, err := templates.EnvFile(instance.DatabaseUsername, string(plain), instance.DatabaseName)
	if err != nil {
		return nil, err
	}
	files, err := templates.PackageProjectFiles(version.PackagePath)
	if err != nil {
		return nil, err
	}
	if err = s.docker.WriteProject(ctx, host, instance, compose, env, files, nil); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 70, "compose", "Starting Docker Compose project", false); err != nil {
		return nil, err
	}
	if err = s.docker.ComposeUp(ctx, host, instance, false); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 95, "health", "Checking database health", false); err != nil {
		return nil, err
	}
	state, health, stateErr := s.docker.InstanceState(ctx, host, instance)
	if stateErr != nil || state != "running" {
		return nil, fmt.Errorf("instance health check failed: state=%s health=%s: %w", state, health, stateErr)
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, "running", "running", ""); err != nil {
		return nil, err
	}
	return map[string]any{"instanceId": instance.ID, "status": "running"}, nil
}

func (s *Service) handleStart(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	return s.simpleAction(ctx, runtime, task, "start")
}
func (s *Service) handleStop(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	return s.simpleAction(ctx, runtime, task, "stop")
}
func (s *Service) handleRestart(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	return s.simpleAction(ctx, runtime, task, "restart")
}

func runtimeConfiguration(cpu float64, memoryBytes, diskBytes int64, configuration json.RawMessage, autoRestart bool) store.InstanceRuntimeConfiguration {
	return store.InstanceRuntimeConfiguration{CPU: cpu, MemoryBytes: memoryBytes, ReservedDiskBytes: diskBytes,
		Configuration: append(json.RawMessage(nil), configuration...), AutoRestart: autoRestart}
}

func instanceHasRuntimeConfiguration(instance domain.Instance, configuration store.InstanceRuntimeConfiguration) bool {
	return instance.CPU == configuration.CPU && instance.MemoryBytes == configuration.MemoryBytes &&
		instance.ReservedDiskBytes == configuration.ReservedDiskBytes && instance.AutoRestart == configuration.AutoRestart &&
		bytes.Equal(instance.Configuration, configuration.Configuration)
}

func runtimeConfigurationResult(instanceID uuid.UUID, status string, configuration store.InstanceRuntimeConfiguration) map[string]any {
	return map[string]any{"instanceId": instanceID, "status": status, "cpu": configuration.CPU,
		"memoryBytes": configuration.MemoryBytes, "reservedDiskBytes": configuration.ReservedDiskBytes,
		"autoRestart": configuration.AutoRestart}
}

func boolValue(value bool) *bool { return &value }

func taskRestartPolicies(payload ActionPayload, instance domain.Instance) (target, previous bool) {
	target, previous = instance.AutoRestart, instance.AutoRestart
	if payload.TargetAutoRestart != nil {
		target = *payload.TargetAutoRestart
	}
	if payload.PreviousAutoRestart != nil {
		previous = *payload.PreviousAutoRestart
	}
	return target, previous
}

func runtimeConfigurationContext(instanceID uuid.UUID) string {
	return "instance:" + instanceID.String() + ":runtime-configuration"
}

func (s *Service) openRuntimeConfiguration(instanceID uuid.UUID, encrypted string) (json.RawMessage, error) {
	plain, err := s.vault.Open(encrypted, runtimeConfigurationContext(instanceID))
	if err != nil {
		return nil, err
	}
	if !json.Valid(plain) {
		return nil, fmt.Errorf("%w: decrypted runtime configuration is not valid JSON", domain.ErrInvalid)
	}
	return json.RawMessage(plain), nil
}

func (s *Service) renderRuntimeProject(instance domain.Instance, template domain.Template, version domain.TemplateVersion,
	configuration json.RawMessage) ([]byte, []byte, map[string][]byte, error) {
	var settings instanceConfiguration
	if err := json.Unmarshal(configuration, &settings); err != nil {
		return nil, nil, nil, fmt.Errorf("%w: instance configuration is not valid JSON", domain.ErrInvalid)
	}
	compose, err := templates.RenderCompose(template, version, instance, settings.ExtraEnvironment)
	if err != nil {
		return nil, nil, nil, err
	}
	plain, err := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
	if err != nil {
		return nil, nil, nil, err
	}
	environment, err := templates.EnvFile(instance.DatabaseUsername, string(plain), instance.DatabaseName)
	if err != nil {
		return nil, nil, nil, err
	}
	files, err := templates.PackageProjectFiles(version.PackagePath)
	return compose, environment, files, err
}

func (s *Service) handleReconfigure(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	payload, instance, host, template, version, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	stable := upgradeStableState(previousStatus, previousDesired)
	targetConfiguration, err := s.openRuntimeConfiguration(instance.ID, payload.EncryptedTargetConfig)
	if err != nil {
		return nil, err
	}
	previousConfiguration, err := s.openRuntimeConfiguration(instance.ID, payload.EncryptedPreviousConfig)
	if err != nil {
		return nil, err
	}
	targetAutoRestart, previousAutoRestart := taskRestartPolicies(payload, instance)
	target := runtimeConfiguration(payload.TargetCPU, payload.TargetMemoryBytes, payload.TargetDiskBytes, targetConfiguration, targetAutoRestart)
	previous := runtimeConfiguration(payload.PreviousCPU, payload.PreviousMemoryBytes, payload.PreviousDiskBytes, previousConfiguration, previousAutoRestart)
	if payload.OperationID != nil {
		// Retrying did not reserve the target configuration. Rollback must return
		// to the configuration present when this attempt started, not a stale
		// snapshot from the original failed task.
		previous = runtimeConfiguration(instance.CPU, instance.MemoryBytes, instance.ReservedDiskBytes,
			instance.Configuration, instance.AutoRestart)
	}
	if (instance.Status == "running" || instance.Status == "stopped") && instanceHasRuntimeConfiguration(instance, target) {
		return runtimeConfigurationResult(instance.ID, instance.Status, target), nil
	}
	previousInstance := instance
	previousInstance.CPU, previousInstance.MemoryBytes, previousInstance.ReservedDiskBytes = previous.CPU, previous.MemoryBytes, previous.ReservedDiskBytes
	previousInstance.AutoRestart = previous.AutoRestart
	previousInstance.Configuration = previous.Configuration
	projectTouched := false
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		canceled := errors.Is(err, tasks.ErrCanceled)
		if canceled {
			_ = runtime.Log(recoveryCtx, "info", "Runtime configuration change was canceled before it was applied")
		} else {
			_ = runtime.Log(recoveryCtx, "warning", "Runtime configuration failed; restoring the previous Compose project")
		}
		recoveryErrors := make([]string, 0, 3)
		if projectTouched {
			compose, environment, files, renderErr := s.renderRuntimeProject(previousInstance, template, version, previous.Configuration)
			if renderErr != nil {
				recoveryErrors = append(recoveryErrors, "render")
			} else if writeErr := s.docker.WriteProject(recoveryCtx, host, previousInstance, compose, environment, files, files); writeErr != nil {
				recoveryErrors = append(recoveryErrors, "write")
			} else if stable.Status == "running" {
				if startErr := s.docker.ComposeUp(recoveryCtx, host, previousInstance, false); startErr != nil {
					recoveryErrors = append(recoveryErrors, "start")
				}
			} else if validateErr := s.docker.ValidateProject(recoveryCtx, host, previousInstance); validateErr != nil {
				recoveryErrors = append(recoveryErrors, "validate")
			}
		}
		message := "Runtime configuration failed; previous configuration was restored"
		if canceled {
			message = "Runtime configuration change was canceled before it was applied"
		}
		status := stable.Status
		if len(recoveryErrors) > 0 {
			status = "failed"
			message = "Runtime configuration failed and automatic recovery did not complete"
		}
		if restoreErr := s.store.FinishInstanceRuntimeConfiguration(recoveryCtx, instance.ID, previous, status, stable.Desired, message); restoreErr != nil {
			_ = runtime.Log(recoveryCtx, "error", "Runtime configuration metadata could not be restored")
		}
	}()

	if err = s.store.ReserveInstanceRuntimeConfiguration(ctx, instance.ID, target); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 15, "render", "Rendering updated runtime configuration", true); err != nil {
		return nil, err
	}
	targetInstance := instance
	targetInstance.CPU, targetInstance.MemoryBytes, targetInstance.ReservedDiskBytes = target.CPU, target.MemoryBytes, target.ReservedDiskBytes
	targetInstance.AutoRestart = target.AutoRestart
	targetInstance.Configuration = target.Configuration
	compose, environment, files, err := s.renderRuntimeProject(targetInstance, template, version, target.Configuration)
	if err != nil {
		return nil, err
	}
	projectTouched = true
	if err = s.docker.WriteProject(ctx, host, targetInstance, compose, environment, files, files); err != nil {
		return nil, err
	}
	if stable.Status == "running" {
		if err = runtime.Stage(ctx, 55, "compose", "Recreating database containers with the updated configuration", false); err != nil {
			return nil, err
		}
		if err = s.docker.ComposeUp(ctx, host, targetInstance, false); err != nil {
			return nil, err
		}
		if err = runtime.Stage(ctx, 85, "health", "Checking the reconfigured database health", false); err != nil {
			return nil, err
		}
		state, health, stateErr := s.docker.InstanceState(ctx, host, targetInstance)
		if stateErr != nil {
			return nil, fmt.Errorf("reconfigured instance health check failed: state=%s health=%s: %w", state, health, stateErr)
		}
		if state != "running" {
			return nil, fmt.Errorf("reconfigured instance health check failed: state=%s health=%s", state, health)
		}
	} else {
		if err = runtime.Stage(ctx, 70, "compose", "Validating the updated stopped database project", false); err != nil {
			return nil, err
		}
		if err = s.docker.ValidateProject(ctx, host, targetInstance); err != nil {
			return nil, err
		}
	}
	if err = s.store.FinishInstanceRuntimeConfiguration(ctx, instance.ID, target, stable.Status, stable.Desired, ""); err != nil {
		return nil, err
	}
	return runtimeConfigurationResult(instance.ID, stable.Status, target), nil
}

func (s *Service) simpleAction(ctx context.Context, runtime *tasks.Runtime, task domain.Task, action string) (result any, err error) {
	payload, instance, host, _, _, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if errors.Is(err, tasks.ErrCanceled) {
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, previousStatus, previousDesired, "")
			return
		}
		failure := instanceActionFailureState(action, previousStatus, previousDesired)
		_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, failure.Status, failure.Desired, failure.Message)
	}()
	if err = s.store.UpdateInstanceState(ctx, instance.ID, instanceOperationStatus(action), previousDesired, ""); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 20, "compose", instanceActionProgressMessage(action), false); err != nil {
		return nil, err
	}
	switch action {
	case "start":
		err = s.docker.ComposeStart(ctx, host, instance)
	case "stop":
		err = s.docker.ComposeStop(ctx, host, instance)
	case "restart":
		err = s.docker.ComposeRestart(ctx, host, instance)
	}
	if err != nil {
		return nil, err
	}
	status := "running"
	desired := "running"
	if action == "stop" {
		status = "stopped"
		desired = "stopped"
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, status, desired, ""); err != nil {
		return nil, err
	}
	return map[string]any{"instanceId": instance.ID, "status": status}, nil
}

func instanceActionProgressMessage(action string) string {
	switch action {
	case "start":
		return "Starting instance"
	case "stop":
		return "Stopping instance"
	case "restart":
		return "Restarting instance"
	default:
		return "Updating instance"
	}
}

func (s *Service) handleDelete(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	payload, instance, host, _, _, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	operationStarted := false
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if !operationStarted && payload.OperationID == nil {
			_ = s.store.RestoreInstanceBackupPolicyAfterDelete(recoveryCtx, instance.ID, deleteBackupPolicyState(payload))
		}
		if errors.Is(err, tasks.ErrCanceled) {
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, previousStatus, previousDesired, "")
			return
		}
		failure := instanceActionFailureState("delete", previousStatus, previousDesired)
		_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, failure.Status, failure.Desired, failure.Message)
	}()
	if err = s.store.UpdateInstanceState(ctx, instance.ID, instanceOperationStatus("delete"), previousDesired, ""); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 10, "compose", "Stopping and removing Compose project", false); err != nil {
		return nil, err
	}
	operationStarted = true
	if err = s.docker.ComposeDown(ctx, host, instance); err != nil {
		return nil, fmt.Errorf("stop Compose project before deleting managed data: %w", err)
	}
	if err = runtime.Stage(ctx, 70, "files", "Removing managed instance data", false); err != nil {
		return nil, err
	}
	if err = s.docker.DeleteInstanceRollbackSnapshots(ctx, host, instance); err != nil {
		return nil, err
	}
	if err = s.docker.RemoveProject(ctx, host, instance); err != nil {
		return nil, err
	}
	if err = s.store.MarkInstanceDeleted(ctx, instance.ID); err != nil {
		return nil, err
	}
	return map[string]any{"instanceId": instance.ID, "status": "deleted"}, nil
}

func (s *Service) handleUpgrade(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	payload, instance, host, template, oldVersion, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	operationID, reuseRollbackSnapshot := rollbackOperation(payload, task)
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	if payload.NewTemplateVersionID == nil {
		return nil, domain.ErrInvalid
	}
	if reuseRollbackSnapshot && instance.Status != "failed" && instance.TemplateVersionID == *payload.NewTemplateVersionID {
		stable := upgradeStableState(previousStatus, previousDesired)
		if err = runtime.Stage(ctx, 95, "finalize", "Finalizing an upgrade that was already applied before interruption", false); err != nil {
			if errors.Is(err, tasks.ErrCanceled) {
				recoveryCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, stable.Status, stable.Desired, "")
				_ = s.store.ResolveAlerts(recoveryCtx, "instance", instance.ID, "upgrade_failed")
				_ = s.docker.DeleteUpgradeSnapshot(recoveryCtx, host, instance, operationID)
			}
			return nil, err
		}
		if err = s.store.UpdateInstanceState(ctx, instance.ID, stable.Status, stable.Desired, ""); err != nil {
			return nil, err
		}
		_ = s.store.ResolveAlerts(ctx, "instance", instance.ID, "upgrade_failed")
		if cleanupErr := s.docker.DeleteUpgradeSnapshot(ctx, host, instance, operationID); cleanupErr != nil {
			_ = runtime.Log(ctx, "warning", "Upgrade was already applied, but the temporary snapshot could not be removed")
		}
		return map[string]any{"instanceId": instance.ID, "version": oldVersion.Version, "alreadyApplied": true}, nil
	}
	var snapshot, targetVersion string
	operationStarted, templateUpdated := false, false
	defer func() {
		if err != nil {
			if errors.Is(err, tasks.ErrCanceled) && !operationStarted {
				recoveryCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				stable := upgradeStableState(previousStatus, previousDesired)
				_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, stable.Status, stable.Desired, "")
				return
			}
			s.recoverUpgradeFailure(runtime, task, operationID, instance, host, oldVersion, previousStatus, previousDesired,
				snapshot, targetVersion, operationStarted, templateUpdated)
		}
	}()
	if err = s.store.UpdateInstanceState(ctx, instance.ID, instanceOperationStatus("upgrade"), previousDesired, ""); err != nil {
		return nil, err
	}
	newTemplate, newVersion, err := s.store.GetTemplateVersion(ctx, *payload.NewTemplateVersionID)
	if err != nil {
		return nil, err
	}
	if !newVersion.Selectable {
		return nil, fmt.Errorf("%w: template version is not available for upgrades", domain.ErrConflict)
	}
	targetVersion = newVersion.Version
	if newTemplate.ID != template.ID {
		return nil, errors.New("upgrade version belongs to a different database template")
	}
	newManifest, manifestErr := templates.ParseManifest(newVersion.Manifest)
	if manifestErr != nil {
		return nil, manifestErr
	}
	if major(oldVersion.Version) != major(newVersion.Version) && newManifest.UpgradeScript == "" {
		return nil, errors.New("major version upgrades require a template-specific migration and are not supported yet")
	}
	previousProjectFiles, err := templates.PackageProjectFiles(oldVersion.PackagePath)
	if err != nil {
		return nil, err
	}
	projectFiles, err := templates.PackageProjectFiles(newVersion.PackagePath)
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 10, "snapshot", "Stopping instance and creating temporary upgrade snapshot", false); err != nil {
		return nil, err
	}
	operationStarted = true
	snapshot, err = s.docker.SnapshotForUpgrade(ctx, host, instance, operationID, reuseRollbackSnapshot, oldVersion.ImageReference)
	if err != nil {
		return nil, err
	}
	var configuration instanceConfiguration
	_ = json.Unmarshal(instance.Configuration, &configuration)
	plain, err := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
	if err != nil {
		return nil, err
	}
	compose, err := templates.RenderCompose(newTemplate, newVersion, instance, configuration.ExtraEnvironment)
	if err != nil {
		return nil, err
	}
	env, _ := templates.EnvFile(instance.DatabaseUsername, string(plain), instance.DatabaseName)
	if err = runtime.Stage(ctx, 35, "image", "Preparing upgraded image", false); err != nil {
		return nil, err
	}
	source, imageArtifactID, registryID := payload.ImageSource, payload.ImageArtifactID, payload.RegistryID
	if source == "" {
		legacyRequest := ActionRequest{NewTemplateVersionID: &newVersion.ID}
		source, imageArtifactID, registryID, _, err = s.prepareUpgrade(ctx, instance, legacyRequest)
		if err != nil {
			return nil, err
		}
	}
	if err = validateUpgradeImageSelection(source, imageArtifactID, registryID); err != nil {
		return nil, err
	}
	if registryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *registryID)
		if getErr != nil {
			return nil, getErr
		}
		if getErr = validateRegistryTemplateSource(registry, newVersion); getErr != nil {
			return nil, getErr
		}
		password := ""
		if registry.EncryptedPassword != "" {
			secret, openErr := s.vault.Open(registry.EncryptedPassword, "registry:"+registry.ID.String()+":password")
			if openErr != nil {
				return nil, openErr
			}
			password = string(secret)
		}
		if registry.EncryptedCACertificate != "" {
			certificate, openErr := s.vault.Open(registry.EncryptedCACertificate, "registry:"+registry.ID.String()+":ca")
			if openErr != nil {
				return nil, openErr
			}
			if err = s.docker.InstallRegistryCA(ctx, host, registry.URL, string(certificate)); err != nil {
				return nil, err
			}
		}
		if err = s.docker.LoginRegistry(ctx, host, registry.URL, registry.Username, password); err != nil {
			return nil, err
		}
	}
	if imageArtifactID != nil {
		artifact, getErr := s.store.GetImageArtifact(ctx, *imageArtifactID)
		if getErr != nil {
			return nil, getErr
		}
		if !artifactSupportsVersion(artifact, host, newVersion) {
			return nil, fmt.Errorf("%w: offline image is incompatible with the upgrade version or instance host", domain.ErrConflict)
		}
		if err = s.docker.LoadImage(ctx, host, artifact.Path, func(done, total int64) {
			if total > 0 {
				_ = s.store.UpdateTask(context.Background(), task.ID, 35+int(done*20/total), "image", "Transferring offline upgrade image", false)
			}
		}); err != nil {
			return nil, err
		}
		markContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err = s.store.MarkImageArtifactUsed(markContext, artifact.ID)
		cancel()
		if err != nil {
			return nil, err
		}
	} else if err = s.pullTemplateImages(ctx, host, newVersion); err != nil {
		return nil, err
	}
	if err = s.docker.WriteProject(ctx, host, instance, compose, env, projectFiles, previousProjectFiles); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 65, "compose", "Starting upgraded database", false); err != nil {
		return nil, err
	}
	if err = s.docker.ComposeUp(ctx, host, instance, false); err != nil {
		return nil, err
	}
	if newManifest.UpgradeScript != "" {
		if err = runtime.Stage(ctx, 80, "migration", "Running template upgrade script", false); err != nil {
			return nil, err
		}
		if err = s.docker.RunProjectScript(ctx, host, instance, newManifest.UpgradeScript); err != nil {
			return nil, err
		}
	}
	state, _, err := s.docker.InstanceState(ctx, host, instance)
	if err != nil {
		return nil, fmt.Errorf("upgraded instance did not become healthy: %w", err)
	}
	if state != "running" {
		return nil, fmt.Errorf("upgraded instance did not become healthy: state=%s", state)
	}
	stable := upgradeStableState(previousStatus, previousDesired)
	if stable.Status == "stopped" {
		if err = runtime.Stage(ctx, 92, "compose", "Restoring the requested stopped state", false); err != nil {
			return nil, err
		}
		if err = s.docker.ComposeStop(ctx, host, instance); err != nil {
			return nil, err
		}
	}
	configuration.ImageArtifactID = imageArtifactID
	configuration.RegistryID = registryID
	updatedConfiguration, marshalErr := json.Marshal(configuration)
	if marshalErr != nil {
		return nil, marshalErr
	}
	if err = s.store.UpdateInstanceTemplateVersionAndConfiguration(ctx, instance.ID, newVersion.ID, updatedConfiguration); err != nil {
		return nil, err
	}
	templateUpdated = true
	if err = s.store.UpdateInstanceState(ctx, instance.ID, stable.Status, stable.Desired, ""); err != nil {
		return nil, err
	}
	_ = s.store.ResolveAlerts(ctx, "instance", instance.ID, "upgrade_failed")
	if cleanupErr := s.docker.DeleteUpgradeSnapshot(ctx, host, instance, operationID); cleanupErr != nil {
		_ = runtime.Log(ctx, "warning", "Upgrade succeeded, but the temporary snapshot could not be removed")
	}
	return map[string]any{"instanceId": instance.ID, "version": newVersion.Version}, nil
}

func (s *Service) recoverUpgradeFailure(runtime *tasks.Runtime, task domain.Task, operationID uuid.UUID, instance domain.Instance, host domain.Host, oldVersion domain.TemplateVersion,
	previousStatus, previousDesired, snapshot, targetVersion string, operationStarted, templateUpdated bool) {
	recoveryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	_ = runtime.Log(recoveryCtx, "warning", "Upgrade failed; attempting to restore the previous database state")

	stable := upgradeStableState(previousStatus, previousDesired)
	recoveryErrors := make([]string, 0, 3)
	stopped := !operationStarted
	if operationStarted {
		if stopErr := s.docker.ComposeStop(recoveryCtx, host, instance); stopErr != nil {
			recoveryErrors = append(recoveryErrors, "stop")
		} else {
			stopped = true
		}
	}
	if snapshot != "" && stopped {
		if restoreErr := s.docker.RestoreUpgradeSnapshot(recoveryCtx, host, instance, operationID, snapshot, oldVersion.ImageReference); restoreErr != nil {
			recoveryErrors = append(recoveryErrors, "snapshot")
		}
	}
	if stable.Status == "running" && len(recoveryErrors) == 0 && operationStarted {
		if startErr := s.docker.ComposeStart(recoveryCtx, host, instance); startErr != nil {
			recoveryErrors = append(recoveryErrors, "start")
		}
	}
	if templateUpdated {
		if versionErr := s.store.UpdateInstanceTemplateVersionAndConfiguration(recoveryCtx, instance.ID, oldVersion.ID, instance.Configuration); versionErr != nil {
			recoveryErrors = append(recoveryErrors, "version")
		}
	}

	recovered := len(recoveryErrors) == 0
	message := "Upgrade failed; previous database state was restored"
	if recovered {
		if stateErr := s.store.UpdateInstanceState(recoveryCtx, instance.ID, stable.Status, stable.Desired, message); stateErr != nil {
			recovered = false
			recoveryErrors = append(recoveryErrors, "state")
		}
		if recovered && snapshot != "" {
			if cleanupErr := s.docker.DeleteUpgradeSnapshot(recoveryCtx, host, instance, operationID); cleanupErr != nil {
				_ = runtime.Log(recoveryCtx, "warning", "Upgrade rollback succeeded, but the temporary snapshot could not be removed")
			}
		}
	}
	if !recovered {
		message = "Upgrade failed and automatic recovery did not complete"
		_ = runtime.Log(recoveryCtx, "error", message+": "+strings.Join(recoveryErrors, ", "))
		_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, "failed", previousDesired, message)
	}

	severity, recoveryStatus := "warning", "restored"
	if !recovered {
		severity, recoveryStatus = "critical", "incomplete"
	}
	activePolicy := platformsettings.DefaultMonitoringPolicy(30, 7)
	if values, settingsErr := s.store.GetSettings(recoveryCtx); settingsErr == nil {
		if configured, decodeErr := platformsettings.DecodeMonitoringPolicy(values["monitoring"], activePolicy); decodeErr == nil {
			activePolicy = configured
		}
	}
	if !activePolicy.AlertEnabled(platformsettings.AlertUpgradeFailed) {
		return
	}
	details := map[string]string{
		"taskId":         task.ID.String(),
		"fromVersion":    oldVersion.Version,
		"toVersion":      targetVersion,
		"recoveryStatus": recoveryStatus,
	}
	if len(recoveryErrors) > 0 {
		details["recoveryFailures"] = strings.Join(recoveryErrors, ",")
	}
	alert, created, alertErr := s.store.CreateAlert(recoveryCtx, store.AlertInput{Severity: severity, Type: "upgrade_failed", ResourceType: "instance",
		ResourceID: instance.ID, Title: "Database upgrade failed", Message: message, Details: details})
	if alertErr == nil && created {
		_ = s.store.EnqueueWebhookEvent(recoveryCtx, "alert.created", alert)
		_ = s.store.EnqueueWebhookEvent(recoveryCtx, "instance.failed", alert)
	}
}

func backupFailureMessage(err error) string {
	message := strings.TrimSpace(err.Error())
	characters := []rune(message)
	if len(characters) > 2000 {
		message = string(characters[:2000])
	}
	return message
}

func (s *Service) handleBackupCreate(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	var scheduledPayload ActionPayload
	if decodeErr := tasks.DecodePayload(task, &scheduledPayload); decodeErr == nil && scheduledPayload.BackupPolicyID != nil {
		_ = s.store.TrackInstanceBackupPolicyTask(ctx, *scheduledPayload.BackupPolicyID, task.ID)
		defer func() {
			status, message := "succeeded", ""
			if err != nil {
				status, message = "failed", backupFailureMessage(err)
				if errors.Is(err, context.Canceled) || errors.Is(err, tasks.ErrCanceled) {
					status = "canceled"
				}
			}
			recordCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			_ = s.store.FinishInstanceBackupPolicyTask(recordCtx, *scheduledPayload.BackupPolicyID, task.ID, status, message)
		}()
	}
	payload, instance, host, _, version, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if payload.BackupID == nil {
		return nil, domain.ErrInvalid
	}
	backup, err := s.store.GetInstanceBackup(ctx, *payload.BackupID)
	if err != nil || backup.InstanceID != instance.ID {
		if err == nil {
			err = domain.ErrNotFound
		}
		return nil, err
	}
	if backup.HostID != host.ID || backup.TemplateVersionID != version.ID {
		return nil, fmt.Errorf("%w: backup source no longer matches the instance host or template version", domain.ErrConflict)
	}
	expectedPath, err := s.docker.BackupArchivePath(host, instance, backup.ID)
	if err != nil || expectedPath != backup.RemotePath {
		if err == nil {
			err = errors.New("backup path is outside the managed backup directory")
		}
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	stable := upgradeStableState(previousStatus, previousDesired)
	operationStarted, backupReady := false, false
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		canceled := errors.Is(err, tasks.ErrCanceled)
		if !backupReady {
			message := backupFailureMessage(err)
			if canceled {
				message = "Backup creation was canceled before the archive was created"
			}
			_ = s.store.SetInstanceBackupStatus(recoveryCtx, backup.ID, "failed", message)
		}
		recovered := true
		if operationStarted && stable.Status == "running" {
			if startErr := s.docker.ComposeStart(recoveryCtx, host, instance); startErr != nil {
				recovered = false
			}
		}
		if recovered {
			message := "Backup failed; original runtime state was restored"
			if canceled {
				message = ""
			}
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, stable.Status, stable.Desired, message)
		} else {
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, "failed", previousDesired, "Backup failed and the original runtime state could not be restored")
		}
	}()
	if err = s.store.SetInstanceBackupStatus(ctx, backup.ID, "creating", ""); err != nil {
		return nil, err
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, "backing_up", previousDesired, ""); err != nil {
		return nil, err
	}
	if stable.Status == "running" {
		if err = runtime.Stage(ctx, 15, "compose", "Stopping instance for a consistent backup", false); err != nil {
			return nil, err
		}
		operationStarted = true
		if err = s.docker.ComposeStop(ctx, host, instance); err != nil {
			return nil, err
		}
	}
	if err = runtime.Stage(ctx, 40, "backup", "Creating protected backup archive", false); err != nil {
		return nil, err
	}
	archive, err := s.docker.CreateBackupArchive(ctx, host, instance, backup.ID, version.ImageReference)
	if err != nil {
		return nil, err
	}
	if err = s.store.CompleteInstanceBackup(ctx, backup.ID, archive.SizeBytes, archive.SHA256); err != nil {
		return nil, err
	}
	backupReady = true
	if stable.Status == "running" {
		if err = runtime.Stage(ctx, 85, "compose", "Restarting instance after backup", false); err != nil {
			return nil, err
		}
		if err = s.docker.ComposeStart(ctx, host, instance); err != nil {
			return nil, err
		}
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, stable.Status, stable.Desired, ""); err != nil {
		return nil, err
	}
	cleanupTaskIDs := make([]uuid.UUID, 0)
	if payload.BackupPolicyID != nil {
		policy, policyErr := s.store.GetInstanceBackupPolicy(ctx, *payload.BackupPolicyID)
		if policyErr == nil && policy.Enabled {
			cleanupTaskIDs, err = s.enqueueBackupRetentionCleanup(ctx, task.RequestedBy, instance.ID, policy.RetentionCount)
			if err != nil {
				_ = runtime.Log(ctx, "warning", "Backup succeeded, but automatic retention cleanup could not be queued: "+backupFailureMessage(err))
				err = nil
			}
		} else if policyErr != nil && !errors.Is(policyErr, domain.ErrNotFound) {
			_ = runtime.Log(ctx, "warning", "Backup succeeded, but the current retention policy could not be loaded: "+backupFailureMessage(policyErr))
		}
	}
	return map[string]any{"instanceId": instance.ID, "backupId": backup.ID, "sizeBytes": archive.SizeBytes,
		"sha256": archive.SHA256, "retentionCleanupTaskIds": cleanupTaskIDs}, nil
}

func (s *Service) enqueueBackupRetentionCleanup(ctx context.Context, userID, instanceID uuid.UUID, keep int) ([]uuid.UUID, error) {
	backups, err := s.store.ListScheduledBackupsBeyondRetention(ctx, instanceID, keep)
	if err != nil {
		return nil, err
	}
	taskIDs := make([]uuid.UUID, 0, len(backups))
	user, _ := s.store.GetUser(ctx, userID)
	for _, backup := range backups {
		_, task, deleteErr := s.DeleteBackup(ctx, userID, instanceID, backup.ID)
		if deleteErr != nil {
			if errors.Is(deleteErr, domain.ErrConflict) || errors.Is(deleteErr, domain.ErrNotFound) {
				continue
			}
			return taskIDs, deleteErr
		}
		taskIDs = append(taskIDs, task.ID)
		_ = s.store.AddAudit(ctx, store.AuditInput{UserID: &userID, Username: user.Username,
			Action: "instance.backup.retention_delete", ResourceType: "backup", ResourceID: &backup.ID,
			ResourceName: backup.Name, TaskID: &task.ID, Result: "success",
			Changes: map[string]any{"instanceId": instanceID, "retentionCount": keep},
			Message: "Scheduled backup exceeded the configured retention count"})
	}
	return taskIDs, nil
}

func (s *Service) handleBackupRestore(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	payload, instance, host, _, version, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if payload.BackupID == nil {
		return nil, domain.ErrInvalid
	}
	operationID, reuseRollbackSnapshot := rollbackOperation(payload, task)
	backup, err := s.store.GetInstanceBackup(ctx, *payload.BackupID)
	if err != nil || backup.InstanceID != instance.ID {
		if err == nil {
			err = domain.ErrNotFound
		}
		return nil, err
	}
	if backup.HostID != host.ID || backup.TemplateVersionID != version.ID {
		return nil, fmt.Errorf("%w: backup template version does not match the instance", domain.ErrConflict)
	}
	expectedPath, err := s.docker.BackupArchivePath(host, instance, backup.ID)
	if err != nil || expectedPath != backup.RemotePath {
		if err == nil {
			err = errors.New("backup path is outside the managed backup directory")
		}
		return nil, err
	}
	previousStatus, previousDesired := currentOrPreviousInstanceState(payload, instance)
	stable := upgradeStableState(previousStatus, previousDesired)
	operationStarted, snapshotReady, restoreStarted, backupUsable := false, false, false, true
	snapshot := ""
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		canceled := errors.Is(err, tasks.ErrCanceled)
		if backupUsable {
			_ = s.store.SetInstanceBackupStatus(recoveryCtx, backup.ID, "ready", "")
		} else {
			_ = s.store.SetInstanceBackupStatus(recoveryCtx, backup.ID, "failed", backupFailureMessage(err))
		}
		recovered := true
		if operationStarted {
			if stopErr := s.docker.ComposeStop(recoveryCtx, host, instance); stopErr != nil {
				recovered = false
			}
			if recovered && restoreStarted && snapshotReady {
				if restoreErr := s.docker.RestoreUpgradeSnapshot(recoveryCtx, host, instance, operationID, snapshot, version.ImageReference); restoreErr != nil {
					recovered = false
				}
			}
			if recovered && stable.Status == "running" {
				if startErr := s.docker.ComposeStart(recoveryCtx, host, instance); startErr != nil {
					recovered = false
				}
			}
		}
		if recovered {
			message := "Restore failed; the pre-restore database state was recovered"
			if canceled {
				message = ""
			}
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, stable.Status, stable.Desired, message)
			if snapshotReady {
				_ = s.docker.DeleteUpgradeSnapshot(recoveryCtx, host, instance, operationID)
			}
		} else {
			_ = s.store.UpdateInstanceState(recoveryCtx, instance.ID, "failed", previousDesired, "Restore failed and automatic rollback did not complete")
		}
	}()
	if err = s.store.SetInstanceBackupStatus(ctx, backup.ID, "restoring", ""); err != nil {
		return nil, err
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, "restoring", previousDesired, ""); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 10, "verify", "Verifying backup archive checksum", false); err != nil {
		return nil, err
	}
	backupUsable = false
	archive, inspectErr := s.docker.InspectBackupArchive(ctx, host, instance, backup.ID)
	if inspectErr != nil {
		return nil, inspectErr
	}
	if archive.Path != backup.RemotePath || archive.SizeBytes != backup.SizeBytes || !strings.EqualFold(archive.SHA256, backup.SHA256) {
		return nil, fmt.Errorf("%w: backup archive checksum or size does not match its metadata", domain.ErrConflict)
	}
	backupUsable = true
	if err = runtime.Stage(ctx, 25, "snapshot", "Creating pre-restore rollback snapshot", false); err != nil {
		return nil, err
	}
	operationStarted = true
	snapshot, err = s.docker.SnapshotForUpgrade(ctx, host, instance, operationID, reuseRollbackSnapshot, version.ImageReference)
	if err != nil {
		return nil, err
	}
	snapshotReady = true
	if err = runtime.Stage(ctx, 50, "restore", "Restoring database files from backup", false); err != nil {
		return nil, err
	}
	restoreStarted = true
	if err = s.docker.RestoreBackupArchive(ctx, host, instance, backup.ID, version.ImageReference); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 75, "compose", "Starting restored database and checking health", false); err != nil {
		return nil, err
	}
	if err = s.docker.ComposeStart(ctx, host, instance); err != nil {
		return nil, err
	}
	state, _, stateErr := s.docker.InstanceState(ctx, host, instance)
	if stateErr != nil {
		return nil, fmt.Errorf("restored instance did not become healthy: %w", stateErr)
	}
	if state != "running" {
		return nil, fmt.Errorf("restored instance did not become healthy: state=%s", state)
	}
	if stable.Status == "stopped" {
		if err = runtime.Stage(ctx, 90, "compose", "Restoring the requested stopped state", false); err != nil {
			return nil, err
		}
		if err = s.docker.ComposeStop(ctx, host, instance); err != nil {
			return nil, err
		}
	}
	if err = s.store.SetInstanceBackupStatus(ctx, backup.ID, "ready", ""); err != nil {
		return nil, err
	}
	if err = s.store.UpdateInstanceState(ctx, instance.ID, stable.Status, stable.Desired, ""); err != nil {
		return nil, err
	}
	if cleanupErr := s.docker.DeleteUpgradeSnapshot(ctx, host, instance, operationID); cleanupErr != nil {
		_ = runtime.Log(ctx, "warning", "Restore succeeded, but the rollback snapshot could not be removed")
	}
	return map[string]any{"instanceId": instance.ID, "backupId": backup.ID, "status": stable.Status}, nil
}

func (s *Service) handleBackupDelete(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (result any, err error) {
	payload, instance, host, _, _, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if payload.BackupID == nil {
		return nil, domain.ErrInvalid
	}
	backup, err := s.store.GetInstanceBackup(ctx, *payload.BackupID)
	if errors.Is(err, domain.ErrNotFound) {
		return map[string]any{"instanceId": instance.ID, "backupId": *payload.BackupID, "deleted": true, "alreadyDeleted": true}, nil
	}
	if err != nil || backup.InstanceID != instance.ID {
		if err == nil {
			err = domain.ErrNotFound
		}
		return nil, err
	}
	if backup.HostID != host.ID {
		return nil, fmt.Errorf("%w: backup host does not match the instance", domain.ErrConflict)
	}
	previousStatus := payload.PreviousBackupStatus
	if previousStatus != "ready" && previousStatus != "failed" {
		previousStatus = "ready"
	}
	defer func() {
		if err == nil {
			return
		}
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		message := backupFailureMessage(err)
		if errors.Is(err, tasks.ErrCanceled) {
			message = ""
		}
		_ = s.store.SetInstanceBackupStatus(recoveryCtx, backup.ID, previousStatus, message)
	}()
	if err = s.store.SetInstanceBackupStatus(ctx, backup.ID, "deleting", ""); err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 40, "files", "Removing backup archive from host", false); err != nil {
		return nil, err
	}
	if err = s.docker.DeleteBackupArchive(ctx, host, instance, backup.ID); err != nil {
		return nil, err
	}
	if err = s.store.DeleteInstanceBackupRecord(ctx, backup.ID); err != nil {
		return nil, err
	}
	return map[string]any{"instanceId": instance.ID, "backupId": backup.ID, "deleted": true}, nil
}

func generatePassword() string {
	buffer := make([]byte, 18)
	_, _ = rand.Read(buffer)
	return "Aa1!" + base64.RawURLEncoding.EncodeToString(buffer)
}
func supports(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}
func max(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
func maxInt(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
func major(value string) string {
	value = strings.TrimLeft(value, "vV")
	if index := strings.IndexAny(value, ".-"); index >= 0 {
		return value[:index]
	}
	return value
}
