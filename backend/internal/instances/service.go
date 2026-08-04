package instances

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
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
	Name               string         `json:"name"`
	HostID             *uuid.UUID     `json:"hostId"`
	TemplateVersionID  uuid.UUID      `json:"templateVersionId"`
	CPU                float64        `json:"cpu"`
	MemoryBytes        int64          `json:"memoryBytes"`
	DiskBytes          int64          `json:"diskBytes"`
	TemplateParameters map[string]any `json:"templateParameters"`
}

type CleanupReview struct {
	InstanceID   uuid.UUID                   `json:"instanceId"`
	InstanceName string                      `json:"instanceName"`
	Status       string                      `json:"status"`
	Purpose      string                      `json:"purpose"`
	Owner        string                      `json:"owner"`
	ExpiresAt    *time.Time                  `json:"expiresAt,omitempty"`
	BackupCount  int                         `json:"backupCount"`
	ActiveTask   *domain.InstanceCleanupTask `json:"activeTask,omitempty"`
	DeleteReady  bool                        `json:"deleteReady"`
	Blockers     []string                    `json:"blockers"`
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
	ExtraEnvironment   map[string]string `json:"extraEnvironment,omitempty"`
	TemplateParameters map[string]any    `json:"templateParameters,omitempty"`
	ImageArtifactID    *uuid.UUID        `json:"imageArtifactId"`
	RegistryID         *uuid.UUID        `json:"registryId"`
}

func resolveTemplateEnvironment(version domain.TemplateVersion, configuration instanceConfiguration, strict bool) (instanceConfiguration, map[string]string, error) {
	manifest, err := templates.ParseManifest(version.Manifest)
	if err != nil {
		return instanceConfiguration{}, nil, err
	}
	values, environment, err := templates.ResolveTemplateParameters(manifest.Parameters,
		configuration.TemplateParameters, configuration.ExtraEnvironment, strict)
	if err != nil {
		return instanceConfiguration{}, nil, err
	}
	configuration.TemplateParameters = values
	return configuration, environment, nil
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
	template, version, err := s.store.GetTemplateVersion(ctx, request.TemplateVersionID)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	if !template.Builtin || template.Tier != "standard" || !version.Selectable {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: template version is not available in the MVP built-in catalog", domain.ErrConflict)
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
	host, hostPort, err := s.selectHost(ctx, request.HostID, version.Architectures, request.CPU, request.MemoryBytes, request.DiskBytes, 0)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	manifest, err := templates.ParseManifest(version.Manifest)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	parameterValues, _, err := templates.ResolveTemplateParameters(manifest.Parameters, request.TemplateParameters, nil, true)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	username, password, databaseName := manifest.Username, "", manifest.Database
	authentication := templates.AuthenticationMode(template, manifest)
	switch authentication {
	case templates.AuthenticationPassword:
		password = generatePassword()
	case templates.AuthenticationUsername:
	case templates.AuthenticationNone:
		username = ""
	}
	instanceID := uuid.New()
	encrypted, err := s.vault.Seal([]byte(password), "instance:"+instanceID.String())
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	configuration, _ := json.Marshal(instanceConfiguration{TemplateParameters: parameterValues})
	short := strings.ReplaceAll(instanceID.String(), "-", "")
	instance, task, err := s.store.CreateInstanceTask(ctx, store.InstanceInput{ID: instanceID, Name: request.Name,
		HostID: host.ID, TemplateVersionID: version.ID, Environment: "development", Labels: json.RawMessage(`{}`),
		AutoRestart: true,
		CPU:         request.CPU, MemoryBytes: request.MemoryBytes, ReservedDiskBytes: request.DiskBytes, HostPort: hostPort,
		ContainerPort: version.DefaultPort, BindAddress: "0.0.0.0", DatabaseUsername: username,
		EncryptedPassword: encrypted, DatabaseName: databaseName, ComposeProject: "dbmock_" + short,
		RemoteDirectory: path.Join(host.DataRoot, "instances", instanceID.String()), Configuration: configuration}, store.TaskInput{
		RequestedBy: userID, Payload: ActionPayload{InstanceID: instanceID},
	})
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	s.tasks.Wake()
	return instance, task, nil
}

func (s *Service) Action(ctx context.Context, userID, instanceID uuid.UUID, action string) (domain.Task, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.Task{}, err
	}
	return s.action(ctx, userID, instance, action)
}

func (s *Service) action(ctx context.Context, userID uuid.UUID, instance domain.Instance, action string) (domain.Task, error) {
	if err := validateInstanceAction(instance.Status, action); err != nil {
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
	payload := ActionPayload{InstanceID: instance.ID,
		PreviousStatus: instance.Status, PreviousDesiredState: instance.DesiredState}
	operationStatus := instanceOperationStatus(action)
	task, err := s.store.CreateInstanceActionTask(ctx, store.TaskInput{Kind: "instance." + action, ResourceType: "instance", ResourceID: &instance.ID,
		RequestedBy: userID, HostID: &instance.HostID, Payload: payload}, instance.ID, instance.Status, operationStatus)
	if err == nil {
		s.tasks.Wake()
	}
	return task, err
}

func (s *Service) GetCleanupReview(ctx context.Context, instanceID uuid.UUID) (CleanupReview, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return CleanupReview{}, err
	}
	backups, err := s.store.ListInstanceBackups(ctx, instanceID)
	if err != nil {
		return CleanupReview{}, err
	}
	activeTask, err := s.store.GetActiveResourceTask(ctx, "instance", instanceID)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return CleanupReview{}, err
	}
	var tasks []domain.Task
	if err == nil {
		tasks = []domain.Task{activeTask}
	}
	return buildCleanupReview(instance, backups, tasks), nil
}

func buildCleanupReview(instance domain.Instance, backups []domain.InstanceBackup, tasks []domain.Task) CleanupReview {
	review := CleanupReview{
		InstanceID: instance.ID, InstanceName: instance.Name, Status: instance.Status,
		Purpose: instance.Purpose, Owner: instance.Owner, ExpiresAt: instance.ExpiresAt,
		BackupCount: len(backups),
	}
	for _, task := range tasks {
		if task.Status == "queued" || task.Status == "running" {
			review.ActiveTask = &domain.InstanceCleanupTask{ID: task.ID, Kind: task.Kind, Status: task.Status, Stage: task.Stage}
			break
		}
	}
	review.Blockers = domain.InstanceCleanupBlockers(instance.Status, review.BackupCount, review.ActiveTask != nil)
	review.DeleteReady = len(review.Blockers) == 0
	return review
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

func artifactSupportsVersion(artifact domain.ImageArtifact, host domain.Host, version domain.TemplateVersion) bool {
	if !supports(artifact.Architectures, host.Architecture) {
		return false
	}
	_, err := artifactDeploymentArchitectures(artifact, version)
	return err == nil
}

func artifactDeploymentArchitectures(artifact domain.ImageArtifact, version domain.TemplateVersion) ([]string, error) {
	if artifact.Status != "ready" {
		return nil, fmt.Errorf("%w: offline image is not ready", domain.ErrConflict)
	}
	references, err := templates.RequiredImageReferences(version)
	if err != nil {
		return nil, err
	}
	for _, reference := range references {
		if !contains(artifact.ImageRefs, reference) {
			return nil, fmt.Errorf("%w: offline image does not contain every image required by the template", domain.ErrConflict)
		}
	}
	architectures := make([]string, 0, len(version.Architectures))
	for _, architecture := range version.Architectures {
		if supports(artifact.Architectures, architecture) {
			architectures = append(architectures, architecture)
		}
	}
	if len(architectures) == 0 {
		return nil, fmt.Errorf("%w: offline image and template do not share a supported architecture", domain.ErrConflict)
	}
	return architectures, nil
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

func currentOrPreviousInstanceState(payload ActionPayload, instance domain.Instance) (string, string) {
	switch instance.Status {
	case "running", "stopped", "degraded", "failed":
		return instance.Status, instance.DesiredState
	default:
		return previousInstanceState(payload, instance)
	}
}

func validateInstanceAction(status, action string) error {
	if action == "delete" {
		if !domain.InstanceStatusAllowsDelete(status) {
			return fmt.Errorf("%w: instance action is not allowed for the current status", domain.ErrConflict)
		}
		return nil
	}
	allowedStatuses := map[string]map[string]bool{
		"start":   {"stopped": true, "failed": true},
		"stop":    {"running": true, "degraded": true},
		"restart": {"running": true, "degraded": true},
	}
	statuses, ok := allowedStatuses[action]
	if !ok {
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
	template, version, err := s.store.GetTemplateVersion(ctx, instance.TemplateVersionID)
	if err != nil {
		return domain.InstanceConnection{}, err
	}
	manifest, err := templates.ParseManifest(version.Manifest)
	if err != nil {
		return domain.InstanceConnection{}, err
	}
	password := ""
	if templates.AuthenticationMode(template, manifest) == templates.AuthenticationPassword {
		plain, openErr := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
		if openErr != nil {
			return domain.InstanceConnection{}, openErr
		}
		password = string(plain)
	}
	return templates.Connection(template, version, instance, instance.ConnectionAddress, password), nil
}

func (s *Service) selectHost(ctx context.Context, requested *uuid.UUID, architectures []string, cpu float64, memory, disk int64, port int) (domain.Host, int, error) {
	if requested != nil {
		host, err := s.store.GetHost(ctx, *requested)
		if err != nil {
			return domain.Host{}, 0, err
		}
		if host.Status != "online" {
			return domain.Host{}, 0, fmt.Errorf("%w: host is not available for deployments", domain.ErrConflict)
		}
		if !supports(architectures, host.Architecture) {
			return domain.Host{}, 0, fmt.Errorf("%w: host architecture is incompatible with the template or selected image", domain.ErrConflict)
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
		if host.Status != "online" || !supports(architectures, host.Architecture) {
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
	configuration, renderedEnvironment, err := resolveTemplateEnvironment(version, configuration, true)
	if err != nil {
		return nil, err
	}
	compose, err := templates.RenderCompose(template, version, instance, renderedEnvironment)
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
	return successfulDeleteResult(instance, host), nil
}

func successfulDeleteResult(instance domain.Instance, host domain.Host) map[string]any {
	return map[string]any{
		"instanceId":              instance.ID,
		"instanceName":            instance.Name,
		"hostId":                  host.ID,
		"hostName":                host.Name,
		"releasedHostPort":        instance.HostPort,
		"releasedBindAddress":     instance.BindAddress,
		"composeProjectRemoved":   true,
		"managedDirectoryRemoved": true,
		"status":                  "deleted",
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
