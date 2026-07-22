package instances

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

const backupSchedulerInterval = 30 * time.Second

type BackupPolicyInput struct {
	Enabled        bool   `json:"enabled"`
	Frequency      string `json:"frequency"`
	Weekday        int    `json:"weekday"`
	Hour           int    `json:"hour"`
	Minute         int    `json:"minute"`
	Timezone       string `json:"timezone"`
	RetentionCount int    `json:"retentionCount"`
}

func validateBackupPolicy(input BackupPolicyInput) (*time.Location, error) {
	input.Frequency = strings.TrimSpace(input.Frequency)
	input.Timezone = strings.TrimSpace(input.Timezone)
	if input.Frequency != "daily" && input.Frequency != "weekly" {
		return nil, fmt.Errorf("%w: backup frequency must be daily or weekly", domain.ErrInvalid)
	}
	if input.Weekday < 0 || input.Weekday > 6 {
		return nil, fmt.Errorf("%w: backup weekday must be between Sunday and Saturday", domain.ErrInvalid)
	}
	if input.Hour < 0 || input.Hour > 23 || input.Minute < 0 || input.Minute > 59 {
		return nil, fmt.Errorf("%w: backup time must use a valid 24-hour clock", domain.ErrInvalid)
	}
	if input.RetentionCount < 1 || input.RetentionCount > 100 {
		return nil, fmt.Errorf("%w: backup retention count must be between 1 and 100", domain.ErrInvalid)
	}
	if input.Timezone == "" || len(input.Timezone) > 128 || input.Timezone == "Local" {
		return nil, fmt.Errorf("%w: backup timezone must be a valid IANA timezone", domain.ErrInvalid)
	}
	location, err := time.LoadLocation(input.Timezone)
	if err != nil {
		return nil, fmt.Errorf("%w: backup timezone must be a valid IANA timezone", domain.ErrInvalid)
	}
	return location, nil
}

func nextBackupRun(after time.Time, input BackupPolicyInput, location *time.Location) time.Time {
	local := after.In(location)
	candidateForDay := func(days int) time.Time {
		day := local.AddDate(0, 0, days)
		candidate := time.Date(day.Year(), day.Month(), day.Day(), input.Hour, input.Minute, 0, 0, location)
		wall := candidate.In(location)
		if wall.Year() == day.Year() && wall.Month() == day.Month() && wall.Day() == day.Day() &&
			wall.Hour() == input.Hour && wall.Minute() == input.Minute {
			return candidate
		}
		// A daylight-saving jump can remove the requested wall-clock minute. Run at
		// the first valid minute after it on that local day instead of silently
		// moving the schedule backward or skipping the day.
		midnight := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, location)
		requestedMinute := input.Hour*60 + input.Minute
		for offset := 0; offset <= 26*60; offset++ {
			probe := midnight.Add(time.Duration(offset) * time.Minute).In(location)
			if probe.Year() == day.Year() && probe.Month() == day.Month() && probe.Day() == day.Day() &&
				probe.Hour()*60+probe.Minute() >= requestedMinute {
				return probe
			}
		}
		return candidate
	}
	candidate := candidateForDay(0)
	if input.Frequency == "weekly" {
		days := (input.Weekday - int(local.Weekday()) + 7) % 7
		candidate = candidateForDay(days)
		if !candidate.After(after) {
			candidate = candidateForDay(days + 7)
		}
	} else if !candidate.After(after) {
		candidate = candidateForDay(1)
	}
	return candidate.UTC()
}

func (s *Service) GetBackupPolicy(ctx context.Context, instanceID uuid.UUID) (domain.InstanceBackupPolicy, error) {
	if _, err := s.store.GetInstance(ctx, instanceID); err != nil {
		return domain.InstanceBackupPolicy{}, err
	}
	return s.store.GetInstanceBackupPolicy(ctx, instanceID)
}

func (s *Service) UpdateBackupPolicy(ctx context.Context, userID, instanceID uuid.UUID, input BackupPolicyInput, now time.Time) (domain.InstanceBackupPolicy, error) {
	location, err := validateBackupPolicy(input)
	if err != nil {
		return domain.InstanceBackupPolicy{}, err
	}
	input.Frequency, input.Timezone = strings.TrimSpace(input.Frequency), strings.TrimSpace(input.Timezone)
	if input.Frequency == "daily" {
		input.Weekday = 0
	}
	var nextRun *time.Time
	if input.Enabled {
		next := nextBackupRun(now, input, location)
		nextRun = &next
	}
	return s.store.UpsertInstanceBackupPolicy(ctx, store.InstanceBackupPolicyInput{
		InstanceID: instanceID, Enabled: input.Enabled, Frequency: input.Frequency, Weekday: input.Weekday,
		Hour: input.Hour, Minute: input.Minute, Timezone: input.Timezone, RetentionCount: input.RetentionCount,
		NextRunAt: nextRun, ConfiguredBy: userID,
	})
}

func (s *Service) StartBackupScheduler(ctx context.Context, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	go func() {
		timer := time.NewTimer(0)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-timer.C:
				s.enqueueDueBackups(ctx, now.UTC(), logger)
				timer.Reset(backupSchedulerInterval)
			}
		}
	}()
}

func (s *Service) enqueueDueBackups(ctx context.Context, now time.Time, logger *slog.Logger) {
	policies, err := s.store.ListDueInstanceBackupPolicies(ctx, now, 25)
	if err != nil {
		logger.Error("list due backup policies", "error", err)
		return
	}
	for _, policy := range policies {
		if _, _, err = s.enqueueScheduledBackup(ctx, policy, now); err != nil {
			if errors.Is(err, domain.ErrConflict) || errors.Is(err, domain.ErrNotFound) {
				logger.Debug("scheduled backup is waiting", "instanceId", policy.InstanceID, "error", err)
				continue
			}
			logger.Error("queue scheduled backup", "instanceId", policy.InstanceID, "error", err)
		}
	}
}

func (s *Service) enqueueScheduledBackup(ctx context.Context, policy domain.InstanceBackupPolicy, now time.Time) (domain.InstanceBackup, domain.Task, error) {
	if !policy.Enabled || policy.NextRunAt == nil || policy.NextRunAt.After(now) {
		return domain.InstanceBackup{}, domain.Task{}, domain.ErrConflict
	}
	instance, err := s.store.GetInstance(ctx, policy.InstanceID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	host, err := s.store.GetHost(ctx, instance.HostID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	location, err := time.LoadLocation(policy.Timezone)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, fmt.Errorf("invalid stored backup timezone: %w", err)
	}
	input := BackupPolicyInput{Enabled: true, Frequency: policy.Frequency, Weekday: policy.Weekday,
		Hour: policy.Hour, Minute: policy.Minute, Timezone: policy.Timezone, RetentionCount: policy.RetentionCount}
	nextRun := nextBackupRun(now, input, location)
	backupID := uuid.New()
	remotePath, err := s.docker.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return domain.InstanceBackup{}, domain.Task{}, err
	}
	name := "Scheduled " + policy.NextRunAt.In(location).Format("2006-01-02 15:04 MST")
	payload := ActionPayload{InstanceID: instance.ID, BackupID: &backupID, BackupPolicyID: &policy.InstanceID,
		ScheduledFor: policy.NextRunAt, PreviousStatus: instance.Status, PreviousDesiredState: instance.DesiredState}
	resourceID := instance.ID
	backup, task, err := s.store.CreateScheduledInstanceBackupTask(ctx, store.TaskInput{Kind: "instance.backup",
		ResourceType: "instance", ResourceID: &resourceID, RequestedBy: policy.ConfiguredBy, HostID: &instance.HostID,
		Payload: payload}, policy, domain.InstanceBackup{ID: backupID, InstanceID: instance.ID, Name: name,
		CreationType: "scheduled", RemotePath: remotePath, CreatedBy: policy.ConfiguredBy}, instance.Status,
		instance.DesiredState, nextRun, now)
	if err != nil {
		return backup, task, err
	}
	auditUserID, auditUsername := backup.CreatedBy, policy.ConfiguredByUsername
	if currentPolicy, policyErr := s.store.GetInstanceBackupPolicy(ctx, policy.InstanceID); policyErr == nil {
		auditUserID, auditUsername = currentPolicy.ConfiguredBy, currentPolicy.ConfiguredByUsername
	}
	_ = s.store.AddAudit(ctx, store.AuditInput{UserID: &auditUserID, Username: auditUsername,
		Action: "instance.backup.schedule_run", ResourceType: "instance", ResourceID: &instance.ID,
		ResourceName: instance.Name, TaskID: &task.ID, Result: "success", Message: "Scheduled backup queued"})
	s.tasks.Wake()
	return backup, task, nil
}
