package instances

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path"
	"sort"
	"strings"

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

type ActionPayload struct {
	InstanceID           uuid.UUID  `json:"instanceId"`
	NewTemplateVersionID *uuid.UUID `json:"newTemplateVersionId,omitempty"`
}

func NewService(target *store.Store, vault *appcrypto.Vault, docker *hostops.Docker, manager *tasks.Manager) *Service {
	service := &Service{store: target, vault: vault, docker: docker, tasks: manager}
	manager.Register("instance.create", service.handleCreate)
	manager.Register("instance.start", service.handleStart)
	manager.Register("instance.stop", service.handleStop)
	manager.Register("instance.restart", service.handleRestart)
	manager.Register("instance.delete", service.handleDelete)
	manager.Register("instance.upgrade", service.handleUpgrade)
	return service
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
	host, err := s.selectHost(ctx, request.HostID, version, request.CPU, request.MemoryBytes, request.DiskBytes, request.HostPort)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	if request.ImageArtifactID != nil {
		artifact, getErr := s.store.GetImageArtifact(ctx, *request.ImageArtifactID)
		if getErr != nil {
			return domain.Instance{}, domain.Task{}, getErr
		}
		if artifact.Status != "ready" || !supports(artifact.Architectures, host.Architecture) || !contains(artifact.ImageRefs, version.ImageReference) {
			return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: offline image is incompatible with the selected template or host", domain.ErrConflict)
		}
	}
	if request.RegistryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *request.RegistryID)
		if getErr != nil {
			return domain.Instance{}, domain.Task{}, getErr
		}
		if getErr = validateRegistryImageSource(registry, version.ImageReference); getErr != nil {
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
	configuration, _ := json.Marshal(map[string]any{"extraEnvironment": request.ExtraEnvironment, "imageArtifactId": request.ImageArtifactID, "registryId": request.RegistryID})
	short := strings.ReplaceAll(instanceID.String(), "-", "")
	instance, err := s.store.CreateInstance(ctx, store.InstanceInput{ID: instanceID, Name: request.Name, ProjectID: request.ProjectID,
		HostID: host.ID, TemplateVersionID: version.ID, Environment: request.Environment, Labels: labels, AutoRestart: autoRestart,
		CPU: request.CPU, MemoryBytes: request.MemoryBytes, ReservedDiskBytes: request.DiskBytes, HostPort: request.HostPort,
		ContainerPort: version.DefaultPort, BindAddress: request.BindAddress, DatabaseUsername: request.Username,
		EncryptedPassword: encrypted, DatabaseName: request.DatabaseName, ComposeProject: "dbmock_" + short,
		RemoteDirectory: path.Join(host.DataRoot, "instances", instanceID.String()), Configuration: configuration})
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	task, err := s.store.CreateTask(ctx, store.TaskInput{Kind: "instance.create", ResourceType: "instance", ResourceID: &instance.ID,
		RequestedBy: userID, HostID: &host.ID, Payload: ActionPayload{InstanceID: instance.ID}})
	if err != nil {
		_ = s.store.MarkInstanceDeleted(ctx, instance.ID)
		return domain.Instance{}, domain.Task{}, err
	}
	s.tasks.Wake()
	_ = template
	return instance, task, nil
}

func (s *Service) Action(ctx context.Context, userID, instanceID uuid.UUID, action string, newVersion *uuid.UUID) (domain.Task, error) {
	instance, err := s.store.GetInstance(ctx, instanceID)
	if err != nil {
		return domain.Task{}, err
	}
	allowed := map[string]bool{"start": true, "stop": true, "restart": true, "delete": true, "upgrade": true}
	if !allowed[action] {
		return domain.Task{}, domain.ErrInvalid
	}
	if action == "upgrade" && newVersion == nil {
		return domain.Task{}, domain.ErrInvalid
	}
	task, err := s.store.CreateTask(ctx, store.TaskInput{Kind: "instance." + action, ResourceType: "instance", ResourceID: &instance.ID,
		RequestedBy: userID, HostID: &instance.HostID, Payload: ActionPayload{InstanceID: instance.ID, NewTemplateVersionID: newVersion}})
	if err == nil {
		s.tasks.Wake()
	}
	return task, err
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

func (s *Service) selectHost(ctx context.Context, requested *uuid.UUID, version domain.TemplateVersion, cpu float64, memory, disk int64, port int) (domain.Host, error) {
	if requested != nil {
		host, err := s.store.GetHost(ctx, *requested)
		if err != nil {
			return domain.Host{}, err
		}
		if host.Status != "online" || host.Maintenance {
			return domain.Host{}, fmt.Errorf("%w: host is not available for deployments", domain.ErrConflict)
		}
		if !supports(version.Architectures, host.Architecture) {
			return domain.Host{}, fmt.Errorf("%w: host architecture is incompatible", domain.ErrConflict)
		}
		reservation, err := s.store.HostReservations(ctx, host.ID)
		if err != nil {
			return domain.Host{}, err
		}
		if !fitsHost(host, reservation, cpu, memory, disk) {
			return domain.Host{}, fmt.Errorf("%w: host does not have enough available resources", domain.ErrConflict)
		}
		if !portAvailable(host, reservation, port) {
			return domain.Host{}, fmt.Errorf("%w: requested port is not available on the selected host", domain.ErrConflict)
		}
		return host, nil
	}
	hosts, err := s.store.ListHosts(ctx)
	if err != nil {
		return domain.Host{}, err
	}
	type candidate struct {
		host  domain.Host
		score float64
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
		candidates = append(candidates, candidate{host, score})
	}
	if len(candidates) == 0 {
		return domain.Host{}, fmt.Errorf("%w: no compatible host has enough resources or the requested port is unavailable", domain.ErrConflict)
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].score > candidates[j].score })
	return candidates[0].host, nil
}

func fitsHost(host domain.Host, reservation store.HostReservation, cpu float64, memory, disk int64) bool {
	return reservation.CPU+cpu <= host.CPUCount*.9 &&
		reservation.Memory+memory <= int64(float64(host.MemoryBytes)*.8) &&
		reservation.Disk+disk <= int64(float64(host.DiskFreeBytes)*.8)
}

func portAvailable(host domain.Host, reservation store.HostReservation, port int) bool {
	if port == 0 {
		return true
	}
	if port < host.PortStart || port > host.PortEnd {
		return false
	}
	_, used := reservation.Ports[port]
	return !used
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
			_ = s.store.UpdateInstanceState(context.Background(), instance.ID, "failed", "", err.Error())
		}
	}()
	if err = runtime.Stage(ctx, 5, "preflight", "Checking host and template", true); err != nil {
		return nil, err
	}
	probe, err := s.docker.Probe(ctx, host)
	if err != nil {
		return nil, err
	}
	if probe.DockerVersion == "" || probe.ComposeVersion == "" {
		return nil, errors.New("Docker Engine and Compose v2 are required")
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
	var configuration struct {
		ExtraEnvironment map[string]string `json:"extraEnvironment"`
		RegistryID       *uuid.UUID        `json:"registryId"`
		ImageArtifactID  *uuid.UUID        `json:"imageArtifactId"`
	}
	_ = json.Unmarshal(instance.Configuration, &configuration)
	if err = runtime.Stage(ctx, 30, "image", "Preparing database image", true); err != nil {
		return nil, err
	}
	if configuration.RegistryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *configuration.RegistryID)
		if getErr != nil {
			return nil, getErr
		}
		if getErr = validateRegistryImageSource(registry, version.ImageReference); getErr != nil {
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
		err = s.docker.LoadImage(ctx, host, artifact.Path, func(done, total int64) {
			if total > 0 {
				_ = s.store.UpdateTask(context.Background(), task.ID, 30+int(done*20/total), "image", "Transferring offline image", true)
			}
		})
	} else {
		err = s.docker.PullImage(ctx, host, version.ImageReference)
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
	if err = s.docker.WriteProject(ctx, host, instance, compose, env, files); err != nil {
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

func (s *Service) simpleAction(ctx context.Context, runtime *tasks.Runtime, task domain.Task, action string) (any, error) {
	_, instance, host, _, _, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 20, "compose", strings.Title(action)+"ing instance", false); err != nil {
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

func (s *Service) handleDelete(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	_, instance, host, _, _, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if err = runtime.Stage(ctx, 10, "compose", "Stopping and removing Compose project", false); err != nil {
		return nil, err
	}
	if err = s.docker.ComposeDown(ctx, host, instance); err != nil {
		_ = runtime.Log(ctx, "warning", "Compose project was already absent or could not be stopped: "+err.Error())
	}
	if err = runtime.Stage(ctx, 70, "files", "Removing managed instance data", false); err != nil {
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

func (s *Service) handleUpgrade(ctx context.Context, runtime *tasks.Runtime, task domain.Task) (any, error) {
	payload, instance, host, template, oldVersion, err := s.load(ctx, task)
	if err != nil {
		return nil, err
	}
	if payload.NewTemplateVersionID == nil {
		return nil, domain.ErrInvalid
	}
	newTemplate, newVersion, err := s.store.GetTemplateVersion(ctx, *payload.NewTemplateVersionID)
	if err != nil {
		return nil, err
	}
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
	if err = runtime.Stage(ctx, 10, "snapshot", "Stopping instance and creating temporary upgrade snapshot", false); err != nil {
		return nil, err
	}
	snapshot, err := s.docker.SnapshotForUpgrade(ctx, host, instance)
	if err != nil {
		return nil, err
	}
	rollback := func(cause error) error {
		_ = runtime.Log(ctx, "warning", "Upgrade failed; restoring temporary snapshot")
		_ = s.docker.RestoreUpgradeSnapshot(context.Background(), host, instance, snapshot)
		_ = s.docker.ComposeStart(context.Background(), host, instance)
		return cause
	}
	var configuration struct {
		ExtraEnvironment map[string]string `json:"extraEnvironment"`
		RegistryID       *uuid.UUID        `json:"registryId"`
	}
	_ = json.Unmarshal(instance.Configuration, &configuration)
	plain, err := s.vault.Open(instance.EncryptedPassword, "instance:"+instance.ID.String())
	if err != nil {
		return nil, rollback(err)
	}
	compose, err := templates.RenderCompose(newTemplate, newVersion, instance, configuration.ExtraEnvironment)
	if err != nil {
		return nil, rollback(err)
	}
	env, _ := templates.EnvFile(instance.DatabaseUsername, string(plain), instance.DatabaseName)
	if err = runtime.Stage(ctx, 35, "image", "Pulling upgraded image", false); err != nil {
		return nil, rollback(err)
	}
	if configuration.RegistryID != nil {
		registry, getErr := s.store.GetRegistry(ctx, *configuration.RegistryID)
		if getErr != nil {
			return nil, rollback(getErr)
		}
		if getErr = validateRegistryImageSource(registry, newVersion.ImageReference); getErr != nil {
			return nil, rollback(getErr)
		}
		password := ""
		if registry.EncryptedPassword != "" {
			secret, openErr := s.vault.Open(registry.EncryptedPassword, "registry:"+registry.ID.String()+":password")
			if openErr != nil {
				return nil, rollback(openErr)
			}
			password = string(secret)
		}
		if registry.EncryptedCACertificate != "" {
			certificate, openErr := s.vault.Open(registry.EncryptedCACertificate, "registry:"+registry.ID.String()+":ca")
			if openErr != nil {
				return nil, rollback(openErr)
			}
			if err = s.docker.InstallRegistryCA(ctx, host, registry.URL, string(certificate)); err != nil {
				return nil, rollback(err)
			}
		}
		if err = s.docker.LoginRegistry(ctx, host, registry.URL, registry.Username, password); err != nil {
			return nil, rollback(err)
		}
	}
	if err = s.docker.PullImage(ctx, host, newVersion.ImageReference); err != nil {
		return nil, rollback(err)
	}
	projectFiles, filesErr := templates.PackageProjectFiles(newVersion.PackagePath)
	if filesErr != nil {
		return nil, rollback(filesErr)
	}
	if err = s.docker.WriteProject(ctx, host, instance, compose, env, projectFiles); err != nil {
		return nil, rollback(err)
	}
	if err = runtime.Stage(ctx, 65, "compose", "Starting upgraded database", false); err != nil {
		return nil, rollback(err)
	}
	if err = s.docker.ComposeUp(ctx, host, instance, false); err != nil {
		return nil, rollback(err)
	}
	if newManifest.UpgradeScript != "" {
		if err = runtime.Stage(ctx, 80, "migration", "Running template upgrade script", false); err != nil {
			return nil, rollback(err)
		}
		if err = s.docker.RunProjectScript(ctx, host, instance, newManifest.UpgradeScript); err != nil {
			return nil, rollback(err)
		}
	}
	state, _, err := s.docker.InstanceState(ctx, host, instance)
	if err != nil || state != "running" {
		return nil, rollback(fmt.Errorf("upgraded instance did not become healthy: %w", err))
	}
	if err = s.store.UpdateInstanceTemplateVersion(ctx, instance.ID, newVersion.ID); err != nil {
		return nil, rollback(err)
	}
	_ = s.docker.DeleteUpgradeSnapshot(ctx, host, instance)
	_ = s.store.UpdateInstanceState(ctx, instance.ID, "running", "running", "")
	return map[string]any{"instanceId": instance.ID, "version": newVersion.Version}, nil
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
