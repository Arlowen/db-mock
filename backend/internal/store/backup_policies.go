package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

// RestoreInstanceBackupPolicyAfterDelete only preserves rollback compatibility for an
// instance deletion queued before backup scheduling was retired from the MVP.
func (s *Store) RestoreInstanceBackupPolicyAfterDelete(ctx context.Context, instanceID uuid.UUID, state *BackupPolicyState) error {
	if state == nil {
		return nil
	}
	if state.Enabled && state.NextRunAt == nil {
		return fmt.Errorf("%w: enabled backup policy recovery requires a next run time", domain.ErrInvalid)
	}
	_, err := s.pool.Exec(ctx, `UPDATE instance_backup_policies SET enabled=$2,
		next_run_at=CASE WHEN $2 THEN $3::timestamptz ELSE NULL END,updated_at=now() WHERE instance_id=$1`,
		instanceID, state.Enabled, state.NextRunAt)
	return err
}
