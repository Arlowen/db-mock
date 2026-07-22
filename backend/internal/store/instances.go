package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/pika/db-mock/internal/domain"
)

type InstanceInput struct {
	ID                uuid.UUID
	Name              string
	ProjectID         *uuid.UUID
	HostID            uuid.UUID
	TemplateVersionID uuid.UUID
	Environment       string
	Labels            json.RawMessage
	AutoRestart       bool
	CPU               float64
	MemoryBytes       int64
	ReservedDiskBytes int64
	HostPort          int
	ContainerPort     int
	BindAddress       string
	DatabaseUsername  string
	EncryptedPassword string
	DatabaseName      string
	ConnectionURI     string
	JDBCURI           string
	ComposeProject    string
	RemoteDirectory   string
	Configuration     json.RawMessage
}

type InstanceRuntimeConfiguration struct {
	CPU               float64
	MemoryBytes       int64
	ReservedDiskBytes int64
	Configuration     json.RawMessage
	AutoRestart       bool
}

const instanceColumns = `i.id,i.name,i.project_id,i.host_id,i.template_version_id,i.environment,i.labels,
    i.status,i.status_message,i.desired_state,i.auto_restart,i.restart_failures,i.cpu,i.memory_bytes,
    i.reserved_disk_bytes,i.host_port,i.container_port,i.bind_address,i.database_username,
    i.encrypted_password,i.encrypted_password<>'',i.database_name,i.connection_uri,i.jdbc_uri,
    i.compose_project,i.remote_directory,i.configuration,i.created_at,i.updated_at,i.last_healthy_at,
    t.slug,t.name,v.version,h.name,h.connection_address`

func instanceScan(item *domain.Instance) []any {
	return []any{&item.ID, &item.Name, &item.ProjectID, &item.HostID, &item.TemplateVersionID,
		&item.Environment, &item.Labels, &item.Status, &item.StatusMessage, &item.DesiredState,
		&item.AutoRestart, &item.RestartFailures, &item.CPU, &item.MemoryBytes, &item.ReservedDiskBytes,
		&item.HostPort, &item.ContainerPort, &item.BindAddress, &item.DatabaseUsername,
		&item.EncryptedPassword, &item.HasPassword, &item.DatabaseName, &item.ConnectionURI, &item.JDBCURI,
		&item.ComposeProject, &item.RemoteDirectory, &item.Configuration, &item.CreatedAt, &item.UpdatedAt,
		&item.LastHealthyAt, &item.TemplateSlug, &item.TemplateName, &item.TemplateVersion, &item.HostName,
		&item.ConnectionAddress}
}

func instanceJoinSQL() string {
	return ` FROM instances i JOIN template_versions v ON v.id=i.template_version_id
        JOIN templates t ON t.id=v.template_id JOIN hosts h ON h.id=i.host_id `
}

func sameOptionalUUID(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *Store) CreateInstanceTask(ctx context.Context, input InstanceInput, taskInput TaskInput) (domain.Instance, domain.Task, error) {
	if strings.TrimSpace(input.Name) == "" || input.HostID == uuid.Nil || input.TemplateVersionID == uuid.Nil || input.CPU <= 0 || input.MemoryBytes <= 0 || input.ReservedDiskBytes <= 0 {
		return domain.Instance{}, domain.Task{}, domain.ErrInvalid
	}
	if len(input.Labels) == 0 {
		input.Labels = json.RawMessage(`{}`)
	}
	if len(input.Configuration) == 0 {
		input.Configuration = json.RawMessage(`{}`)
	}
	var configuration struct {
		ImageArtifactID *uuid.UUID `json:"imageArtifactId"`
		RegistryID      *uuid.UUID `json:"registryId"`
	}
	if err := json.Unmarshal(input.Configuration, &configuration); err != nil {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: instance configuration is not valid JSON", domain.ErrInvalid)
	}
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
	}
	payload, err := json.Marshal(taskInput.Payload)
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	var taskReferences struct {
		InstanceID      uuid.UUID  `json:"instanceId"`
		ImageArtifactID *uuid.UUID `json:"imageArtifactId"`
		RegistryID      *uuid.UUID `json:"registryId"`
	}
	if err = json.Unmarshal(payload, &taskReferences); err != nil || taskReferences.InstanceID != input.ID ||
		!sameOptionalUUID(taskReferences.ImageArtifactID, configuration.ImageArtifactID) ||
		!sameOptionalUUID(taskReferences.RegistryID, configuration.RegistryID) {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: instance creation task does not match the requested instance or image source", domain.ErrInvalid)
	}
	resourceID, hostID := input.ID, input.HostID
	taskInput.Kind = "instance.create"
	taskInput.ResourceType = "instance"
	taskInput.ResourceID = &resourceID
	taskInput.HostID = &hostID
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var host domain.Host
	err = tx.QueryRow(ctx, "SELECT "+hostColumns+" FROM hosts WHERE id=$1 FOR UPDATE", input.HostID).Scan(hostScan(&host)...)
	if err != nil {
		return domain.Instance{}, domain.Task{}, translate(err)
	}
	if host.Status != "online" || host.Maintenance {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: selected host is not available", domain.ErrConflict)
	}
	var templateID uuid.UUID
	if err = tx.QueryRow(ctx, "SELECT template_id FROM template_versions WHERE id=$1 FOR KEY SHARE", input.TemplateVersionID).Scan(&templateID); err != nil {
		return domain.Instance{}, domain.Task{}, translate(err)
	}
	if err = lockTaskSourceReferences(ctx, tx, taskInput.Kind, payload); err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	var usedCPU float64
	var usedMemory, usedDisk int64
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(cpu),0),coalesce(sum(memory_bytes),0),coalesce(sum(reserved_disk_bytes),0)
        FROM instances WHERE host_id=$1 AND status<>'deleted'`, input.HostID).Scan(&usedCPU, &usedMemory, &usedDisk); err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	if usedCPU+input.CPU > host.CPUCount*0.9 || usedMemory+input.MemoryBytes > int64(float64(host.MemoryBytes)*0.8) || usedDisk+input.ReservedDiskBytes > int64(float64(host.DiskFreeBytes)*0.8) {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: insufficient host resources", domain.ErrConflict)
	}
	if input.HostPort == 0 {
		if err := tx.QueryRow(ctx, `SELECT p FROM generate_series($2::integer,$3::integer) p WHERE NOT EXISTS
            (SELECT 1 FROM instances WHERE host_id=$1 AND host_port=p AND status<>'deleted') ORDER BY p LIMIT 1`,
			input.HostID, host.PortStart, host.PortEnd).Scan(&input.HostPort); err != nil {
			return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: no port is available", domain.ErrConflict)
		}
	}
	if input.HostPort < host.PortStart || input.HostPort > host.PortEnd {
		return domain.Instance{}, domain.Task{}, fmt.Errorf("%w: port is outside host port pool", domain.ErrInvalid)
	}
	item := domain.Instance{ID: input.ID}
	err = tx.QueryRow(ctx, `INSERT INTO instances(id,name,project_id,host_id,template_version_id,environment,
        labels,status,desired_state,auto_restart,cpu,memory_bytes,reserved_disk_bytes,host_port,
        container_port,bind_address,database_username,encrypted_password,database_name,connection_uri,
        jdbc_uri,compose_project,remote_directory,configuration)
        VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning','running',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22) RETURNING id`, item.ID, strings.TrimSpace(input.Name), input.ProjectID,
		input.HostID, input.TemplateVersionID, input.Environment, input.Labels, input.AutoRestart, input.CPU,
		input.MemoryBytes, input.ReservedDiskBytes, input.HostPort, input.ContainerPort, input.BindAddress,
		input.DatabaseUsername, input.EncryptedPassword, input.DatabaseName, input.ConnectionURI,
		input.JDBCURI, input.ComposeProject, input.RemoteDirectory, input.Configuration).Scan(&item.ID)
	if err != nil {
		if strings.Contains(err.Error(), "instances_name_lower_idx") || strings.Contains(err.Error(), "instances_host_id_host_port_key") {
			return domain.Instance{}, domain.Task{}, domain.ErrConflict
		}
		return domain.Instance{}, domain.Task{}, err
	}
	task := domain.Task{ID: uuid.New()}
	err = tx.QueryRow(ctx, `INSERT INTO tasks(id,kind,resource_type,resource_id,requested_by,host_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+taskColumns, task.ID, taskInput.Kind, taskInput.ResourceType,
		taskInput.ResourceID, taskInput.RequestedBy, taskInput.HostID, payload).Scan(taskScan(&task)...)
	if err != nil {
		return domain.Instance{}, domain.Task{}, taskInsertError(err)
	}
	err = tx.QueryRow(ctx, "SELECT "+instanceColumns+instanceJoinSQL()+" WHERE i.id=$1", item.ID).Scan(instanceScan(&item)...)
	if err != nil {
		return domain.Instance{}, domain.Task{}, translate(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Instance{}, domain.Task{}, err
	}
	return item, task, nil
}

func (s *Store) GetInstance(ctx context.Context, id uuid.UUID) (domain.Instance, error) {
	var item domain.Instance
	err := s.pool.QueryRow(ctx, "SELECT "+instanceColumns+instanceJoinSQL()+" WHERE i.id=$1", id).Scan(instanceScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListInstances(ctx context.Context, hostID, projectID *uuid.UUID, status string) ([]domain.Instance, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+instanceColumns+instanceJoinSQL()+`
        WHERE i.status<>'deleted' AND ($1::uuid IS NULL OR i.host_id=$1) AND ($2::uuid IS NULL OR i.project_id=$2)
        AND ($3='' OR i.status=$3) ORDER BY i.created_at DESC`, hostID, projectID, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Instance, 0)
	for rows.Next() {
		var item domain.Instance
		if err := rows.Scan(instanceScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateInstanceState(ctx context.Context, id uuid.UUID, status, desired, message string) error {
	_, err := s.pool.Exec(ctx, `UPDATE instances SET status=$2,
        desired_state=CASE WHEN $3='' THEN desired_state ELSE $3 END,status_message=$4,
        last_healthy_at=CASE WHEN $2='running' THEN now() ELSE last_healthy_at END,
        restart_failures=CASE WHEN $2='running' THEN 0 ELSE restart_failures END,updated_at=now() WHERE id=$1`,
		id, status, desired, message)
	return err
}

func (s *Store) IncrementRestartFailure(ctx context.Context, id uuid.UUID) (int, error) {
	var count int
	err := s.pool.QueryRow(ctx, `UPDATE instances SET restart_failures=restart_failures+1,updated_at=now()
        WHERE id=$1 RETURNING restart_failures`, id).Scan(&count)
	return count, translate(err)
}

func (s *Store) UpdateInstanceMetadata(ctx context.Context, id uuid.UUID, name string, projectID *uuid.UUID, environment string, labels json.RawMessage) (domain.Instance, error) {
	_, err := s.pool.Exec(ctx, `UPDATE instances SET name=$2,project_id=$3,environment=$4,labels=$5,
        updated_at=now() WHERE id=$1 AND status<>'deleted'`, id, name, projectID, environment, labels)
	if err != nil {
		return domain.Instance{}, err
	}
	return s.GetInstance(ctx, id)
}

func (s *Store) MarkInstanceDeleted(ctx context.Context, id uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE instances SET status='deleted',desired_state='deleted',status_message='',
        updated_at=now() WHERE id=$1`, id)
	return err
}

func (s *Store) UpdateInstanceTemplateVersionAndConfiguration(ctx context.Context, id, versionID uuid.UUID, configuration json.RawMessage) error {
	if !json.Valid(configuration) {
		return fmt.Errorf("%w: instance configuration is not valid JSON", domain.ErrInvalid)
	}
	result, err := s.pool.Exec(ctx, `UPDATE instances SET template_version_id=$2,configuration=$3,updated_at=now()
		WHERE id=$1 AND status<>'deleted'`, id, versionID, configuration)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func validateRuntimeConfiguration(input InstanceRuntimeConfiguration) error {
	if input.CPU <= 0 || input.MemoryBytes <= 0 || input.ReservedDiskBytes <= 0 || !json.Valid(input.Configuration) {
		return fmt.Errorf("%w: runtime configuration is invalid", domain.ErrInvalid)
	}
	return nil
}

func runtimeConfigurationFits(current, target InstanceRuntimeConfiguration, usedCPU, cpuLimit float64,
	usedMemory, memoryLimit, usedDisk, diskLimit int64) bool {
	return !(usedCPU+target.CPU > cpuLimit && target.CPU > current.CPU ||
		usedMemory+target.MemoryBytes > memoryLimit && target.MemoryBytes > current.MemoryBytes ||
		usedDisk+target.ReservedDiskBytes > diskLimit && target.ReservedDiskBytes > current.ReservedDiskBytes)
}

func lockRuntimeCapacity(ctx context.Context, tx pgx.Tx, instanceID, hostID uuid.UUID,
	current, input InstanceRuntimeConfiguration) error {
	var cpuCount float64
	var memoryBytes, diskFreeBytes int64
	var status string
	var maintenance bool
	if err := tx.QueryRow(ctx, `SELECT cpu_count,memory_bytes,disk_free_bytes,status,maintenance FROM hosts WHERE id=$1 FOR UPDATE`, hostID).
		Scan(&cpuCount, &memoryBytes, &diskFreeBytes, &status, &maintenance); err != nil {
		return translate(err)
	}
	if status != "online" || maintenance {
		return fmt.Errorf("%w: selected host is not available", domain.ErrConflict)
	}
	var usedCPU float64
	var usedMemory, usedDisk int64
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(cpu),0),coalesce(sum(memory_bytes),0),coalesce(sum(reserved_disk_bytes),0)
        FROM instances WHERE host_id=$1 AND id<>$2 AND status<>'deleted'`, hostID, instanceID).
		Scan(&usedCPU, &usedMemory, &usedDisk); err != nil {
		return err
	}
	if !runtimeConfigurationFits(current, input, usedCPU, cpuCount*.9, usedMemory, int64(float64(memoryBytes)*.8),
		usedDisk, int64(float64(diskFreeBytes)*.8)) {
		return fmt.Errorf("%w: host does not have enough capacity for the requested runtime configuration", domain.ErrConflict)
	}
	return nil
}

func (s *Store) CreateInstanceReconfigureTask(ctx context.Context, input TaskInput, instanceID uuid.UUID,
	expectedStatus string, target InstanceRuntimeConfiguration) (domain.Task, error) {
	if err := validateRuntimeConfiguration(target); err != nil {
		return domain.Task{}, err
	}
	payload, err := json.Marshal(input.Payload)
	if err != nil {
		return domain.Task{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Task{}, err
	}
	defer tx.Rollback(ctx)
	var currentStatus string
	var hostID uuid.UUID
	var current InstanceRuntimeConfiguration
	if err = tx.QueryRow(ctx, `SELECT status,host_id,cpu,memory_bytes,reserved_disk_bytes,configuration,auto_restart FROM instances WHERE id=$1 FOR UPDATE`, instanceID).
		Scan(&currentStatus, &hostID, &current.CPU, &current.MemoryBytes, &current.ReservedDiskBytes, &current.Configuration, &current.AutoRestart); err != nil {
		return domain.Task{}, translate(err)
	}
	if currentStatus != expectedStatus {
		return domain.Task{}, fmt.Errorf("%w: instance state changed while queuing the operation", domain.ErrConflict)
	}
	if err = lockRuntimeCapacity(ctx, tx, instanceID, hostID, current, target); err != nil {
		return domain.Task{}, err
	}
	if err = lockTaskSourceReferences(ctx, tx, input.Kind, payload); err != nil {
		return domain.Task{}, err
	}
	item := domain.Task{ID: uuid.New()}
	err = tx.QueryRow(ctx, `INSERT INTO tasks(id,kind,resource_type,resource_id,requested_by,host_id,payload)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING `+taskColumns, item.ID, input.Kind, input.ResourceType,
		input.ResourceID, input.RequestedBy, input.HostID, payload).Scan(taskScan(&item)...)
	if err != nil {
		return domain.Task{}, taskInsertError(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET cpu=$2,memory_bytes=$3,reserved_disk_bytes=$4,
		configuration=$5,auto_restart=$6,status='reconfiguring',status_message='',updated_at=now() WHERE id=$1`,
		instanceID, target.CPU, target.MemoryBytes, target.ReservedDiskBytes, target.Configuration, target.AutoRestart); err != nil {
		return domain.Task{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Task{}, err
	}
	return item, nil
}

func (s *Store) ReserveInstanceRuntimeConfiguration(ctx context.Context, id uuid.UUID, target InstanceRuntimeConfiguration) error {
	if err := validateRuntimeConfiguration(target); err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var status string
	var hostID uuid.UUID
	var current InstanceRuntimeConfiguration
	if err = tx.QueryRow(ctx, `SELECT status,host_id,cpu,memory_bytes,reserved_disk_bytes,configuration,auto_restart FROM instances WHERE id=$1 FOR UPDATE`, id).
		Scan(&status, &hostID, &current.CPU, &current.MemoryBytes, &current.ReservedDiskBytes, &current.Configuration, &current.AutoRestart); err != nil {
		return translate(err)
	}
	if status != "running" && status != "stopped" && status != "degraded" && status != "reconfiguring" {
		return fmt.Errorf("%w: instance state does not allow runtime reconfiguration", domain.ErrConflict)
	}
	if err = lockRuntimeCapacity(ctx, tx, id, hostID, current, target); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE instances SET cpu=$2,memory_bytes=$3,reserved_disk_bytes=$4,
		configuration=$5,auto_restart=$6,status='reconfiguring',status_message='',updated_at=now() WHERE id=$1`,
		id, target.CPU, target.MemoryBytes, target.ReservedDiskBytes, target.Configuration, target.AutoRestart); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FinishInstanceRuntimeConfiguration(ctx context.Context, id uuid.UUID, configuration InstanceRuntimeConfiguration,
	status, desiredState, message string) error {
	if err := validateRuntimeConfiguration(configuration); err != nil {
		return err
	}
	result, err := s.pool.Exec(ctx, `UPDATE instances SET cpu=$2,memory_bytes=$3,reserved_disk_bytes=$4,
		configuration=$5,auto_restart=$6,status=$7,desired_state=$8,status_message=$9,updated_at=now()
		WHERE id=$1 AND status<>'deleted'`, id, configuration.CPU, configuration.MemoryBytes,
		configuration.ReservedDiskBytes, configuration.Configuration, configuration.AutoRestart, status, desiredState, message)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

func (s *Store) ListInstanceMetrics(ctx context.Context, instanceID uuid.UUID, since time.Time, limit int) ([]domain.MetricSample, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.pool.Query(ctx, `WITH ordered AS (
        SELECT id,host_id,instance_id,cpu_percent,memory_bytes,memory_percent,disk_used_bytes,disk_total_bytes,
            collected_at,row_number() OVER (ORDER BY collected_at,id) AS sample_number,count(*) OVER () AS sample_count
        FROM metric_samples WHERE instance_id=$1 AND collected_at>=$2
    ), bucketed AS (
        SELECT *,CASE WHEN sample_count<=$3 THEN sample_number
            ELSE 1+((sample_number-1)*($3-1)/NULLIF(sample_count-1,0)) END AS sample_bucket
        FROM ordered
    ), sampled AS (
        SELECT *,row_number() OVER (PARTITION BY sample_bucket ORDER BY
            CASE WHEN sample_bucket=$3 THEN collected_at END DESC,
            CASE WHEN sample_bucket<>$3 THEN collected_at END ASC,id ASC) AS bucket_rank
        FROM bucketed
    )
    SELECT id,host_id,instance_id,cpu_percent,memory_bytes,memory_percent,disk_used_bytes,disk_total_bytes,collected_at
    FROM sampled WHERE bucket_rank=1 ORDER BY collected_at ASC`, instanceID, since, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.MetricSample, 0)
	for rows.Next() {
		var item domain.MetricSample
		if err := rows.Scan(&item.ID, &item.HostID, &item.InstanceID, &item.CPUPercent, &item.MemoryBytes,
			&item.MemoryPercent, &item.DiskUsedBytes, &item.DiskTotalBytes, &item.CollectedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) AddMetric(ctx context.Context, metric domain.MetricSample) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO metric_samples(host_id,instance_id,cpu_percent,memory_bytes,
        memory_percent,disk_used_bytes,disk_total_bytes,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
		metric.HostID, metric.InstanceID, metric.CPUPercent, metric.MemoryBytes, metric.MemoryPercent,
		metric.DiskUsedBytes, metric.DiskTotalBytes, metric.CollectedAt)
	return err
}

func (s *Store) DeleteOldMetrics(ctx context.Context, before time.Time) (int64, error) {
	result, err := s.pool.Exec(ctx, "DELETE FROM metric_samples WHERE collected_at<$1", before)
	return result.RowsAffected(), err
}
