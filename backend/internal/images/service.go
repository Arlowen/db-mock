package images

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	platformsettings "github.com/pika/db-mock/internal/settings"
	"github.com/pika/db-mock/internal/store"
)

const (
	incompleteUploadRetention = 7 * 24 * time.Hour
	uploadCleanupInterval     = time.Hour
)

type Service struct {
	store         *store.Store
	directory     string
	maxBytes      int64
	uploadGate    sync.RWMutex
	locks         sync.Map
	artifactLocks [64]sync.Mutex
}

func New(target *store.Store, directory string, maxBytes int64) *Service {
	return &Service{store: target, directory: directory, maxBytes: maxBytes}
}

func (s *Service) Begin(ctx context.Context, userID uuid.UUID, filename string, total int64, expectedHash string) (domain.Upload, error) {
	filename = filepath.Base(filename)
	lower := strings.ToLower(filename)
	if !(strings.HasSuffix(lower, ".tar") || strings.HasSuffix(lower, ".tar.gz") || strings.HasSuffix(lower, ".tgz")) {
		return domain.Upload{}, fmt.Errorf("%w: only .tar, .tar.gz and .tgz are accepted", domain.ErrInvalid)
	}
	policy := s.uploadPolicy(ctx)
	if total <= 0 || total > policy.MaxBytes {
		return domain.Upload{}, fmt.Errorf("%w: upload size is outside the configured limit", domain.ErrInvalid)
	}
	id := uuid.New()
	temporary := filepath.Join(s.directory, "uploads", id.String()+".part")
	if err := os.MkdirAll(filepath.Dir(temporary), 0o750); err != nil {
		return domain.Upload{}, err
	}
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return domain.Upload{}, err
	}
	_ = file.Close()
	return s.store.CreateUpload(ctx, domain.Upload{ID: id, Filename: filename, TemporaryPath: temporary, TotalBytes: total, ExpectedSHA256: strings.ToLower(expectedHash), Status: "uploading", CreatedBy: userID})
}

func (s *Service) uploadPolicy(ctx context.Context) platformsettings.UploadPolicy {
	values, err := s.store.GetSettings(ctx)
	if err != nil {
		return platformsettings.DefaultUploadPolicy(s.maxBytes)
	}
	return resolveUploadPolicy(values, s.maxBytes)
}

func resolveUploadPolicy(values map[string]json.RawMessage, maxAllowedBytes int64) platformsettings.UploadPolicy {
	defaults := platformsettings.DefaultUploadPolicy(maxAllowedBytes)
	policy, err := platformsettings.DecodeUploadPolicy(values["uploads"], defaults, maxAllowedBytes)
	if err != nil {
		return defaults
	}
	return policy
}

func (s *Service) WriteChunk(ctx context.Context, userID, id uuid.UUID, offset int64, source io.Reader, length int64) (domain.Upload, error) {
	s.uploadGate.RLock()
	defer s.uploadGate.RUnlock()
	lock := s.lock(id)
	lock.Lock()
	defer lock.Unlock()
	upload, err := s.store.GetUpload(ctx, id)
	if err != nil {
		return upload, err
	}
	if upload.CreatedBy != userID {
		return upload, domain.ErrForbidden
	}
	if upload.Status != "uploading" {
		return upload, domain.ErrConflict
	}
	if offset != upload.ReceivedBytes {
		return upload, fmt.Errorf("%w: expected chunk offset %d", domain.ErrConflict, upload.ReceivedBytes)
	}
	if length <= 0 || offset+length > upload.TotalBytes {
		return upload, domain.ErrInvalid
	}
	file, err := os.OpenFile(upload.TemporaryPath, os.O_WRONLY, 0o600)
	if err != nil {
		return upload, err
	}
	defer file.Close()
	if _, err = file.Seek(offset, io.SeekStart); err != nil {
		return upload, err
	}
	written, err := io.CopyN(file, source, length)
	if err != nil {
		return upload, err
	}
	if written != length {
		return upload, io.ErrUnexpectedEOF
	}
	upload.ReceivedBytes += written
	if err = s.store.UpdateUploadProgress(ctx, id, upload.ReceivedBytes, "uploading"); err != nil {
		return upload, err
	}
	return upload, nil
}

func (s *Service) Complete(ctx context.Context, userID, id uuid.UUID, name string) (domain.ImageArtifact, error) {
	s.uploadGate.RLock()
	defer s.uploadGate.RUnlock()
	lock := s.lock(id)
	lock.Lock()
	defer lock.Unlock()
	defer s.locks.Delete(id)
	upload, err := s.store.GetUpload(ctx, id)
	if err != nil {
		return domain.ImageArtifact{}, err
	}
	if upload.CreatedBy != userID {
		return domain.ImageArtifact{}, domain.ErrForbidden
	}
	if upload.ReceivedBytes != upload.TotalBytes {
		return domain.ImageArtifact{}, fmt.Errorf("%w: upload is incomplete", domain.ErrConflict)
	}
	file, err := os.Open(upload.TemporaryPath)
	if err != nil {
		return domain.ImageArtifact{}, err
	}
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	_ = file.Close()
	if err != nil {
		return domain.ImageArtifact{}, err
	}
	digest := hex.EncodeToString(hash.Sum(nil))
	if upload.ExpectedSHA256 != "" && upload.ExpectedSHA256 != digest {
		return domain.ImageArtifact{}, fmt.Errorf("%w: SHA-256 checksum does not match", domain.ErrInvalid)
	}
	artifactLock := s.artifactLock(digest)
	artifactLock.Lock()
	defer artifactLock.Unlock()
	refs, architectures, format, err := inspectArchive(upload.TemporaryPath)
	if err != nil {
		return domain.ImageArtifact{}, fmt.Errorf("%w: %v", domain.ErrInvalid, err)
	}
	extension := ".tar"
	if strings.HasSuffix(strings.ToLower(upload.Filename), ".gz") || strings.HasSuffix(strings.ToLower(upload.Filename), ".tgz") {
		extension = ".tar.gz"
	}
	destination := filepath.Join(s.directory, "images", digest+extension)
	if err = os.MkdirAll(filepath.Dir(destination), 0o750); err != nil {
		return domain.ImageArtifact{}, err
	}
	if _, statErr := os.Stat(destination); os.IsNotExist(statErr) {
		if err = os.Rename(upload.TemporaryPath, destination); err != nil {
			return domain.ImageArtifact{}, err
		}
	} else {
		_ = os.Remove(upload.TemporaryPath)
	}
	if name == "" {
		name = upload.Filename
	}
	artifact, err := s.store.CreateImageArtifact(ctx, domain.ImageArtifact{ID: uuid.New(), Name: name, Filename: upload.Filename,
		Path: destination, SizeBytes: upload.TotalBytes, SHA256: digest, Format: format, ImageRefs: refs, Architectures: architectures,
		Status: "ready", CreatedBy: userID})
	if err != nil {
		return artifact, err
	}
	_ = s.store.UpdateUploadProgress(ctx, id, upload.TotalBytes, "complete")
	return artifact, nil
}

func (s *Service) Cancel(ctx context.Context, userID, id uuid.UUID) error {
	s.uploadGate.RLock()
	defer s.uploadGate.RUnlock()
	lock := s.lock(id)
	lock.Lock()
	defer lock.Unlock()
	defer s.locks.Delete(id)
	upload, err := s.store.GetUpload(ctx, id)
	if err != nil {
		return err
	}
	if upload.CreatedBy != userID {
		return domain.ErrForbidden
	}
	path, err := s.store.DeleteUpload(ctx, id)
	if err != nil {
		return err
	}
	if err = os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *Service) Delete(ctx context.Context, id uuid.UUID) error {
	return s.delete(ctx, id, nil)
}

func (s *Service) DeleteUnused(ctx context.Context, id uuid.UUID, before time.Time) error {
	return s.delete(ctx, id, &before)
}

func (s *Service) delete(ctx context.Context, id uuid.UUID, before *time.Time) error {
	item, err := s.store.GetImageArtifact(ctx, id)
	if err != nil {
		return err
	}
	lock := s.artifactLock(item.SHA256)
	lock.Lock()
	defer lock.Unlock()
	if before == nil {
		item, err = s.store.BeginDeleteImageArtifact(ctx, id)
	} else {
		item, err = s.store.BeginDeleteUnusedImageArtifact(ctx, id, *before)
	}
	if err != nil {
		return err
	}
	if item.Path != "" {
		if err = os.Remove(item.Path); err != nil && !os.IsNotExist(err) {
			s.restoreArtifact(id)
			return err
		}
	}
	return s.store.CompleteDeleteImageArtifact(ctx, id)
}

func (s *Service) lock(id uuid.UUID) *sync.Mutex {
	value, _ := s.locks.LoadOrStore(id, &sync.Mutex{})
	return value.(*sync.Mutex)
}

func (s *Service) artifactLock(digest string) *sync.Mutex {
	index := 0
	for _, value := range digest {
		index = (index*33 + int(value)) % len(s.artifactLocks)
	}
	return &s.artifactLocks[index]
}

func (s *Service) restoreArtifact(id uuid.UUID) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.store.RestoreImageArtifact(ctx, id)
}

// CleanupExpiredUploads removes upload sessions and temporary files that have
// not been active since before the supplied cutoff. The exclusive gate keeps a
// cleanup pass from racing an in-process chunk write, completion, or cancel.
func (s *Service) CleanupExpiredUploads(ctx context.Context, before time.Time) (int, error) {
	s.uploadGate.Lock()
	defer s.uploadGate.Unlock()
	paths, err := s.store.DeleteExpiredUploads(ctx, before)
	if err != nil {
		return 0, err
	}
	var cleanupErrors []error
	for _, path := range paths {
		if err = s.removeUploadTemporaryFile(path); err != nil {
			cleanupErrors = append(cleanupErrors, err)
		}
	}
	return len(paths), errors.Join(cleanupErrors...)
}

func (s *Service) removeUploadTemporaryFile(path string) error {
	uploadDirectory, err := filepath.Abs(filepath.Join(s.directory, "uploads"))
	if err != nil {
		return fmt.Errorf("resolve managed upload directory: %w", err)
	}
	target, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolve upload temporary file: %w", err)
	}
	base := filepath.Base(target)
	if filepath.Dir(target) != uploadDirectory || !strings.HasSuffix(base, ".part") {
		return errors.New("refusing to remove a file outside the managed upload directory")
	}
	if _, err = uuid.Parse(strings.TrimSuffix(base, ".part")); err != nil {
		return errors.New("refusing to remove an invalid managed upload filename")
	}
	if err = os.Remove(target); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove expired upload temporary file: %w", err)
	}
	return nil
}

// StartUploadCleanup performs an initial sweep and then repeats it hourly for
// the lifetime of ctx. Completed upload records are also pruned because their
// temporary files have already been promoted to the image store.
func (s *Service) StartUploadCleanup(ctx context.Context, logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	go func() {
		run := func(now time.Time) {
			count, err := s.CleanupExpiredUploads(ctx, now.Add(-incompleteUploadRetention))
			if err != nil {
				logger.Warn("clean expired image uploads", "error", err)
				return
			}
			if count > 0 {
				logger.Info("cleaned expired image uploads", "count", count)
			}
		}
		run(time.Now().UTC())
		ticker := time.NewTicker(uploadCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				run(now.UTC())
			}
		}
	}()
}
