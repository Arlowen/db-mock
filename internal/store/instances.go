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

func (s *Store) CreateInstance(ctx context.Context, input InstanceInput) (domain.Instance, error) {
	if strings.TrimSpace(input.Name) == "" || input.HostID == uuid.Nil || input.TemplateVersionID == uuid.Nil || input.CPU <= 0 || input.MemoryBytes <= 0 || input.ReservedDiskBytes <= 0 {
		return domain.Instance{}, domain.ErrInvalid
	}
	if len(input.Labels) == 0 {
		input.Labels = json.RawMessage(`{}`)
	}
	if len(input.Configuration) == 0 {
		input.Configuration = json.RawMessage(`{}`)
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Instance{}, err
	}
	defer tx.Rollback(ctx)
	var host domain.Host
	err = tx.QueryRow(ctx, "SELECT "+hostColumns+" FROM hosts WHERE id=$1 FOR UPDATE", input.HostID).Scan(hostScan(&host)...)
	if err != nil {
		return domain.Instance{}, translate(err)
	}
	if host.Status != "online" || host.Maintenance {
		return domain.Instance{}, fmt.Errorf("%w: selected host is not available", domain.ErrConflict)
	}
	var usedCPU float64
	var usedMemory, usedDisk int64
	if err := tx.QueryRow(ctx, `SELECT coalesce(sum(cpu),0),coalesce(sum(memory_bytes),0),coalesce(sum(reserved_disk_bytes),0)
        FROM instances WHERE host_id=$1 AND status<>'deleted'`, input.HostID).Scan(&usedCPU, &usedMemory, &usedDisk); err != nil {
		return domain.Instance{}, err
	}
	if usedCPU+input.CPU > host.CPUCount*0.9 || usedMemory+input.MemoryBytes > int64(float64(host.MemoryBytes)*0.8) || usedDisk+input.ReservedDiskBytes > int64(float64(host.DiskFreeBytes)*0.8) {
		return domain.Instance{}, fmt.Errorf("%w: insufficient host resources", domain.ErrConflict)
	}
	if input.HostPort == 0 {
		if err := tx.QueryRow(ctx, `SELECT p FROM generate_series($2,$3) p WHERE NOT EXISTS
            (SELECT 1 FROM instances WHERE host_id=$1 AND host_port=p AND status<>'deleted') ORDER BY p LIMIT 1`,
			input.HostID, host.PortStart, host.PortEnd).Scan(&input.HostPort); err != nil {
			return domain.Instance{}, fmt.Errorf("%w: no port is available", domain.ErrConflict)
		}
	}
	if input.HostPort < host.PortStart || input.HostPort > host.PortEnd {
		return domain.Instance{}, fmt.Errorf("%w: port is outside host port pool", domain.ErrInvalid)
	}
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
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
			return domain.Instance{}, domain.ErrConflict
		}
		return domain.Instance{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Instance{}, err
	}
	return s.GetInstance(ctx, item.ID)
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

func (s *Store) UpdateInstanceMetadata(ctx context.Context, id uuid.UUID, name string, projectID *uuid.UUID, environment string, labels json.RawMessage, autoRestart bool) (domain.Instance, error) {
	_, err := s.pool.Exec(ctx, `UPDATE instances SET name=$2,project_id=$3,environment=$4,labels=$5,
        auto_restart=$6,updated_at=now() WHERE id=$1 AND status<>'deleted'`, id, name, projectID,
		environment, labels, autoRestart)
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

func (s *Store) UpdateInstanceTemplateVersion(ctx context.Context, id, versionID uuid.UUID) error {
	_, err := s.pool.Exec(ctx, `UPDATE instances SET template_version_id=$2,updated_at=now() WHERE id=$1`, id, versionID)
	return err
}

func (s *Store) ListInstanceMetrics(ctx context.Context, instanceID uuid.UUID, since time.Time, limit int) ([]domain.MetricSample, error) {
	if limit <= 0 || limit > 5000 {
		limit = 1000
	}
	rows, err := s.pool.Query(ctx, `SELECT id,host_id,instance_id,cpu_percent,memory_bytes,memory_percent,
        disk_used_bytes,disk_total_bytes,collected_at FROM metric_samples WHERE instance_id=$1 AND collected_at>=$2
        ORDER BY collected_at ASC LIMIT $3`, instanceID, since, limit)
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
