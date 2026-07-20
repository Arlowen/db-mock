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

type HostInput struct {
	ID                  uuid.UUID
	ProjectID           *uuid.UUID
	Name                string
	SSHAddress          string
	SSHPort             int
	SSHUser             string
	AuthType            string
	EncryptedCredential string
	HostKey             string
	ConnectionAddress   string
	DataRoot            string
	PortStart           int
	PortEnd             int
	ManageDocker        bool
	ProxyHTTP           string
	ProxyHTTPS          string
	ProxyNoProxy        string
	Maintenance         bool
	AutoRestartDefault  bool
	Labels              json.RawMessage
	DataRootWritable    bool
	PortProbeAvailable  bool
	AvailablePort       int
}

func (s *Store) CreateHost(ctx context.Context, input HostInput) (domain.Host, error) {
	if input.SSHPort == 0 {
		input.SSHPort = 22
	}
	if input.PortStart == 0 {
		input.PortStart = 20000
	}
	if input.PortEnd == 0 {
		input.PortEnd = 40000
	}
	if len(input.Labels) == 0 {
		input.Labels = json.RawMessage(`{}`)
	}
	if strings.TrimSpace(input.Name) == "" || strings.TrimSpace(input.SSHAddress) == "" || strings.TrimSpace(input.SSHUser) == "" || input.EncryptedCredential == "" {
		return domain.Host{}, domain.ErrInvalid
	}
	if input.ID == uuid.Nil {
		input.ID = uuid.New()
	}
	item := domain.Host{ID: input.ID}
	err := s.pool.QueryRow(ctx, `INSERT INTO hosts(id,project_id,name,ssh_address,ssh_port,ssh_user,auth_type,
        encrypted_credential,host_key,connection_address,data_root,port_start,port_end,manage_docker,
        proxy_http,proxy_https,proxy_no_proxy,maintenance,auto_restart_default,labels,data_root_writable,
        port_probe_available,available_port)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        RETURNING `+hostColumns, item.ID, input.ProjectID, strings.TrimSpace(input.Name), input.SSHAddress,
		input.SSHPort, input.SSHUser, input.AuthType, input.EncryptedCredential, input.HostKey,
		input.ConnectionAddress, input.DataRoot, input.PortStart, input.PortEnd, input.ManageDocker,
		input.ProxyHTTP, input.ProxyHTTPS, input.ProxyNoProxy, input.Maintenance, input.AutoRestartDefault,
		input.Labels, input.DataRootWritable, input.PortProbeAvailable, input.AvailablePort).Scan(hostScan(&item)...)
	if err != nil && strings.Contains(err.Error(), "hosts_name_lower_idx") {
		return domain.Host{}, domain.ErrConflict
	}
	return item, err
}

const hostColumns = `id,project_id,name,ssh_address,ssh_port,ssh_user,auth_type,encrypted_credential,
    host_key,connection_address,data_root,port_start,port_end,manage_docker,proxy_http,proxy_https,
    proxy_no_proxy,os,distro,architecture,docker_version,compose_version,cpu_count,memory_bytes,
    disk_total_bytes,disk_free_bytes,data_root_writable,port_probe_available,available_port,status,
    status_message,maintenance,auto_restart_default,last_seen_at,last_checked_at,consecutive_failures,
    labels,created_at,updated_at`

func hostScan(item *domain.Host) []any {
	return []any{&item.ID, &item.ProjectID, &item.Name, &item.SSHAddress, &item.SSHPort, &item.SSHUser,
		&item.AuthType, &item.EncryptedCredential, &item.HostKey, &item.ConnectionAddress, &item.DataRoot,
		&item.PortStart, &item.PortEnd, &item.ManageDocker, &item.ProxyHTTP, &item.ProxyHTTPS,
		&item.ProxyNoProxy, &item.OS, &item.Distro, &item.Architecture, &item.DockerVersion,
		&item.ComposeVersion, &item.CPUCount, &item.MemoryBytes, &item.DiskTotalBytes, &item.DiskFreeBytes,
		&item.DataRootWritable, &item.PortProbeAvailable, &item.AvailablePort, &item.Status,
		&item.StatusMessage, &item.Maintenance, &item.AutoRestartDefault, &item.LastSeenAt,
		&item.LastCheckedAt, &item.ConsecutiveFailures, &item.Labels, &item.CreatedAt, &item.UpdatedAt}
}

func (s *Store) GetHost(ctx context.Context, id uuid.UUID) (domain.Host, error) {
	var item domain.Host
	err := s.pool.QueryRow(ctx, "SELECT "+hostColumns+" FROM hosts WHERE id=$1", id).Scan(hostScan(&item)...)
	return item, translate(err)
}

func (s *Store) ListHosts(ctx context.Context) ([]domain.Host, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+hostColumns+" FROM hosts ORDER BY lower(name)")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Host, 0)
	for rows.Next() {
		var item domain.Host
		if err := rows.Scan(hostScan(&item)...); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) UpdateHost(ctx context.Context, id uuid.UUID, input HostInput) (domain.Host, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return domain.Host{}, err
	}
	defer tx.Rollback(ctx)
	var existingRoot string
	if err = tx.QueryRow(ctx, "SELECT data_root FROM hosts WHERE id=$1 FOR UPDATE", id).Scan(&existingRoot); err != nil {
		return domain.Host{}, translate(err)
	}
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE resource_type='host' AND resource_id=$1
        AND status IN ('queued','running'))`, id).Scan(&active); err != nil {
		return domain.Host{}, err
	}
	if active {
		return domain.Host{}, domain.ErrConflict
	}
	if input.DataRoot != existingRoot {
		var managedData bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM instances WHERE host_id=$1 AND status<>'deleted')
            OR EXISTS(SELECT 1 FROM instance_backups WHERE host_id=$1)`, id).Scan(&managedData); err != nil {
			return domain.Host{}, err
		}
		if managedData {
			return domain.Host{}, fmt.Errorf("%w: data root cannot be changed while the host has managed instances or backups", domain.ErrConflict)
		}
	}
	var portOutsidePool bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM instances WHERE host_id=$1 AND status<>'deleted'
        AND (host_port<$2 OR host_port>$3))`, id, input.PortStart, input.PortEnd).Scan(&portOutsidePool); err != nil {
		return domain.Host{}, err
	}
	if portOutsidePool {
		return domain.Host{}, fmt.Errorf("%w: the port pool must include every managed instance port", domain.ErrConflict)
	}
	if len(input.Labels) == 0 {
		input.Labels = json.RawMessage(`{}`)
	}
	var item domain.Host
	err = tx.QueryRow(ctx, `UPDATE hosts SET project_id=$2,name=$3,ssh_address=$4,ssh_port=$5,
        ssh_user=$6,auth_type=$7,encrypted_credential=CASE WHEN $8='' THEN encrypted_credential ELSE $8 END,
        host_key=CASE WHEN $9='' THEN host_key ELSE $9 END,connection_address=$10,data_root=$11,
        port_start=$12,port_end=$13,manage_docker=$14,proxy_http=$15,proxy_https=$16,proxy_no_proxy=$17,
        maintenance=$18,auto_restart_default=$19,labels=$20,data_root_writable=$21,
        port_probe_available=$22,available_port=$23,updated_at=now() WHERE id=$1 RETURNING `+hostColumns,
		id, input.ProjectID, input.Name, input.SSHAddress, input.SSHPort, input.SSHUser, input.AuthType,
		input.EncryptedCredential, input.HostKey, input.ConnectionAddress, input.DataRoot, input.PortStart,
		input.PortEnd, input.ManageDocker, input.ProxyHTTP, input.ProxyHTTPS, input.ProxyNoProxy,
		input.Maintenance, input.AutoRestartDefault, input.Labels, input.DataRootWritable,
		input.PortProbeAvailable, input.AvailablePort).Scan(hostScan(&item)...)
	if err != nil {
		return domain.Host{}, translate(err)
	}
	if err = tx.Commit(ctx); err != nil {
		return domain.Host{}, err
	}
	return item, nil
}

type HostProbe struct {
	HostKey            string
	OS                 string
	Distro             string
	Architecture       string
	DockerVersion      string
	ComposeVersion     string
	CPUCount           float64
	MemoryBytes        int64
	DiskTotalBytes     int64
	DiskFreeBytes      int64
	DataRootWritable   bool
	PortProbeAvailable bool
	AvailablePort      int
	Status             string
	StatusMessage      string
}

func (s *Store) UpdateHostProbe(ctx context.Context, id uuid.UUID, probe HostProbe) error {
	_, err := s.pool.Exec(ctx, `UPDATE hosts SET host_key=CASE WHEN $2='' THEN host_key ELSE $2 END,os=$3,
        distro=$4,architecture=$5,docker_version=$6,compose_version=$7,cpu_count=$8,memory_bytes=$9,
        disk_total_bytes=$10,disk_free_bytes=$11,data_root_writable=$12,port_probe_available=$13,
        available_port=$14,status=$15,status_message=$16,last_checked_at=now(),last_seen_at=now(),
        consecutive_failures=0,updated_at=now()
        WHERE id=$1`, id, probe.HostKey, probe.OS, probe.Distro, probe.Architecture, probe.DockerVersion,
		probe.ComposeVersion, probe.CPUCount, probe.MemoryBytes, probe.DiskTotalBytes, probe.DiskFreeBytes,
		probe.DataRootWritable, probe.PortProbeAvailable, probe.AvailablePort, probe.Status, probe.StatusMessage)
	return err
}

func (s *Store) SetHostStatus(ctx context.Context, id uuid.UUID, status, message string, success bool) error {
	_, err := s.pool.Exec(ctx, `UPDATE hosts SET status=$2,status_message=$3,last_checked_at=now(),
        last_seen_at=CASE WHEN $4 THEN now() ELSE last_seen_at END,
        consecutive_failures=CASE WHEN $4 THEN 0 ELSE consecutive_failures+1 END,updated_at=now() WHERE id=$1`,
		id, status, message, success)
	return err
}

func (s *Store) DeleteHost(ctx context.Context, id uuid.UUID) error {
	active, err := s.HasActiveResourceTask(ctx, "host", id)
	if err != nil {
		return err
	}
	if active {
		return domain.ErrConflict
	}
	var count int
	if err := s.pool.QueryRow(ctx, "SELECT count(*) FROM instances WHERE host_id=$1 AND status<>'deleted'", id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return domain.ErrConflict
	}
	result, err := s.pool.Exec(ctx, "DELETE FROM hosts WHERE id=$1", id)
	if err == nil && result.RowsAffected() == 0 {
		return domain.ErrNotFound
	}
	return err
}

type HostReservation struct {
	CPU       float64
	Memory    int64
	Disk      int64
	Ports     map[int]struct{}
	UpdatedAt time.Time
}

func (s *Store) HostReservations(ctx context.Context, hostID uuid.UUID) (HostReservation, error) {
	result := HostReservation{Ports: make(map[int]struct{})}
	rows, err := s.pool.Query(ctx, `SELECT cpu,memory_bytes,reserved_disk_bytes,host_port,updated_at FROM instances
        WHERE host_id=$1 AND status<>'deleted'`, hostID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var cpu float64
		var memory, disk int64
		var port int
		var updated time.Time
		if err := rows.Scan(&cpu, &memory, &disk, &port, &updated); err != nil {
			return result, err
		}
		result.CPU += cpu
		result.Memory += memory
		result.Disk += disk
		result.Ports[port] = struct{}{}
		if updated.After(result.UpdatedAt) {
			result.UpdatedAt = updated
		}
	}
	return result, rows.Err()
}
