package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

type Handler func(context.Context, *Runtime, domain.Task) (any, error)
type CancellationPreparer func(context.Context, domain.Task) (*store.QueuedTaskRecovery, error)

const (
	taskFinalizationTimeout       = 15 * time.Second
	applicationStoppedTaskMessage = "The control service stopped while the task was running"
)

type Manager struct {
	store                 *store.Store
	logger                *slog.Logger
	workers               int
	handlers              map[string]Handler
	cancellationPreparers map[string]CancellationPreparer
	wake                  chan struct{}
	wg                    sync.WaitGroup
}

type Runtime struct {
	store  *store.Store
	taskID domain.Task
}

func New(target *store.Store, logger *slog.Logger, workers int) *Manager {
	return &Manager{store: target, logger: logger, workers: workers, handlers: make(map[string]Handler),
		cancellationPreparers: make(map[string]CancellationPreparer), wake: make(chan struct{}, 1)}
}

func (m *Manager) Register(kind string, handler Handler) { m.handlers[kind] = handler }
func (m *Manager) RegisterCancellation(kind string, preparer CancellationPreparer) {
	m.cancellationPreparers[kind] = preparer
}

func (m *Manager) CancelTask(ctx context.Context, id uuid.UUID) (domain.Task, error) {
	task, err := m.store.GetTask(ctx, id)
	if err != nil {
		return domain.Task{}, err
	}
	var recovery *store.QueuedTaskRecovery
	if task.Status == "queued" {
		if prepare, ok := m.cancellationPreparers[task.Kind]; ok {
			recovery, err = prepare(ctx, task)
			if err != nil {
				return domain.Task{}, err
			}
		}
	}
	task, err = m.store.CancelTask(ctx, id, recovery)
	if err == nil && task.Status == "canceled" {
		m.NotifyTaskFinished(ctx, task)
	}
	return task, err
}

func (m *Manager) Start(ctx context.Context) error {
	if err := m.store.InterruptRunningTasks(ctx); err != nil {
		return err
	}
	for i := 0; i < m.workers; i++ {
		m.wg.Add(1)
		go m.worker(ctx, i)
	}
	return nil
}

func (m *Manager) Wait() { m.wg.Wait() }
func (m *Manager) Wake() {
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *Manager) worker(ctx context.Context, index int) {
	defer m.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		task, err := m.store.ClaimTask(ctx)
		if err != nil {
			if !errors.Is(err, domain.ErrNotFound) {
				m.logger.Error("claim task", "worker", index, "error", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-m.wake:
			case <-time.After(time.Second):
			}
			continue
		}
		m.run(ctx, task)
	}
}

func (m *Manager) run(parent context.Context, task domain.Task) {
	runtime := &Runtime{store: m.store, taskID: task}
	handler, ok := m.handlers[task.Kind]
	if !ok {
		message := "No task handler is registered"
		m.finish(parent, runtime, task, "failed", nil, "unknown_task_kind", message, "error", message)
		return
	}
	_ = runtime.Log(parent, "info", "Task started")
	result, err := handler(parent, runtime, task)
	if err != nil {
		status := "failed"
		code := classifyTaskFailure(err)
		message := redact(err.Error())
		switch {
		case errors.Is(err, ErrCanceled):
			status = "canceled"
			code = "canceled"
		case errors.Is(err, context.Canceled) && parent.Err() != nil:
			status = "interrupted"
			code = "application_stopped"
			message = applicationStoppedTaskMessage
		}
		m.finish(parent, runtime, task, status, failureResult(err), code, message, "error", message)
		m.logger.Warn("task finished with error", "taskId", task.ID, "kind", task.Kind, "status", status, "error", redact(err.Error()))
		return
	}
	if m.finish(parent, runtime, task, "succeeded", result, "", "", "info", "Task completed") {
		m.Wake()
	}
}

func classifyTaskFailure(err error) string {
	message := strings.ToLower(err.Error())
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "operation_timeout"
	case strings.Contains(message, "ssh credential is invalid") ||
		strings.Contains(message, "decrypt ssh credential") ||
		strings.Contains(message, "unable to authenticate") ||
		strings.Contains(message, "no supported methods remain"):
		return "ssh_credential_invalid"
	case strings.Contains(message, "ssh host key changed"):
		return "ssh_host_key_changed"
	case strings.Contains(message, "dial ssh ") ||
		strings.Contains(message, "ssh handshake:") ||
		strings.Contains(message, "create ssh session:") ||
		strings.Contains(message, "create sftp client:"):
		return "ssh_unreachable"
	case strings.Contains(message, "no space left on device"):
		return "host_disk_full"
	case strings.Contains(message, "mounts denied") ||
		strings.Contains(message, "is not shared from the host and is not known to docker"):
		return "host_path_not_shared"
	case strings.Contains(message, "port is already allocated") ||
		strings.Contains(message, "address already in use") ||
		strings.Contains(message, "bind: address in use"):
		return "port_conflict"
	case strings.Contains(message, "instance health check failed") ||
		strings.Contains(message, "container is unhealthy") ||
		strings.Contains(message, "health check failed"):
		return "health_check_failed"
	case strings.Contains(message, "pull access denied") ||
		strings.Contains(message, "manifest unknown") ||
		strings.Contains(message, "failed to resolve reference") ||
		strings.Contains(message, "failed to authorize") ||
		strings.Contains(message, "unexpected eof"):
		return "image_pull_failed"
	default:
		return "task_failed"
	}
}

func (m *Manager) finish(parent context.Context, runtime *Runtime, task domain.Task, status string, result any,
	errorCode, errorMessage, logLevel, logMessage string,
) bool {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), taskFinalizationTimeout)
	defer cancel()
	if logMessage != "" {
		if err := runtime.Log(ctx, logLevel, logMessage); err != nil {
			m.logger.Error("write final task log", "taskId", task.ID, "kind", task.Kind, "status", status, "error", err)
		}
	}
	if err := m.store.FinishTask(ctx, task.ID, status, result, errorCode, errorMessage); err != nil {
		m.logger.Error("finish task", "taskId", task.ID, "kind", task.Kind, "status", status, "error", err)
		return false
	}
	if err := m.enqueueWebhook(ctx, task, status); err != nil {
		m.logger.Warn("enqueue task webhook", "taskId", task.ID, "kind", task.Kind, "status", status, "error", err)
	}
	return true
}

func (m *Manager) enqueueWebhook(ctx context.Context, original domain.Task, status string) error {
	task, err := m.store.GetTask(ctx, original.ID)
	if err != nil {
		return err
	}
	return errors.Join(
		m.store.EnqueueWebhookEvent(ctx, "task.finished", task),
		m.store.EnqueueWebhookEvent(ctx, "task."+status, task),
	)
}

// NotifyTaskFinished publishes the same durable completion events used by a
// worker for a task that was completed synchronously before execution.
func (m *Manager) NotifyTaskFinished(ctx context.Context, task domain.Task) {
	if err := m.enqueueWebhook(ctx, task, task.Status); err != nil {
		m.logger.Warn("enqueue task webhook", "taskId", task.ID, "kind", task.Kind, "status", task.Status, "error", err)
	}
}

var ErrCanceled = errors.New("task canceled")

func (r *Runtime) Stage(ctx context.Context, progress int, stage, message string, cancelable bool) error {
	// Advancing the stage and closing its cancellation window must be one row
	// update. If a cancellation wins that race, stop before the next external
	// side effect; if this update wins, a later cancellation is rejected.
	cancelRequested, err := r.store.AdvanceTaskStage(ctx, r.taskID.ID, progress, stage, message, cancelable)
	if err != nil {
		return err
	}
	if cancelRequested {
		return ErrCanceled
	}
	return r.Log(ctx, "info", message)
}
func (r *Runtime) Log(ctx context.Context, level, message string) error {
	return r.store.AddTaskLog(ctx, r.taskID.ID, level, redact(message))
}
func (r *Runtime) Store() *store.Store { return r.store }

func redact(value string) string {
	patterns := []string{"password=", "password: ", "token=", "secret=", "private key"}
	lower := strings.ToLower(value)
	for _, pattern := range patterns {
		if index := strings.Index(lower, pattern); index >= 0 {
			return value[:index] + pattern + "[REDACTED]"
		}
	}
	if len(value) > 8000 {
		return value[:8000] + "…"
	}
	return value
}

func DecodePayload(task domain.Task, target any) error {
	if err := jsonUnmarshal(task.Payload, target); err != nil {
		return fmt.Errorf("decode task payload: %w", err)
	}
	return nil
}

var jsonUnmarshal = func(data []byte, target any) error {
	return json.Unmarshal(data, target)
}
