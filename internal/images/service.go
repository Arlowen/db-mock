package images

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

type Service struct {
	store     *store.Store
	directory string
	maxBytes  int64
	locks     sync.Map
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
	if total <= 0 || total > s.maxBytes {
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

func (s *Service) WriteChunk(ctx context.Context, userID, id uuid.UUID, offset int64, source io.Reader, length int64) (domain.Upload, error) {
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
	path, err := s.store.DeleteImageArtifact(ctx, id)
	if err != nil {
		return err
	}
	if path != "" {
		return os.Remove(path)
	}
	return nil
}

func (s *Service) lock(id uuid.UUID) *sync.Mutex {
	value, _ := s.locks.LoadOrStore(id, &sync.Mutex{})
	return value.(*sync.Mutex)
}

type dockerManifestItem struct {
	Config   string   `json:"Config"`
	RepoTags []string `json:"RepoTags"`
}

func inspectArchive(filename string) ([]string, []string, string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, nil, "", err
	}
	defer file.Close()
	var reader io.Reader = file
	format := "docker-archive"
	magic := make([]byte, 2)
	_, _ = io.ReadFull(file, magic)
	_, _ = file.Seek(0, io.SeekStart)
	if len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gzipReader, err := gzip.NewReader(file)
		if err != nil {
			return nil, nil, "", err
		}
		defer gzipReader.Close()
		reader = gzipReader
	}
	tarReader := tar.NewReader(reader)
	var manifest []dockerManifestItem
	configs := make(map[string][]byte)
	var ociIndex []byte
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, "", fmt.Errorf("read image archive: %w", err)
		}
		name := strings.TrimPrefix(filepath.ToSlash(header.Name), "./")
		if name == "manifest.json" {
			data, _ := io.ReadAll(io.LimitReader(tarReader, 8*1024*1024))
			if err := json.Unmarshal(data, &manifest); err != nil {
				return nil, nil, "", fmt.Errorf("parse Docker manifest: %w", err)
			}
		} else if name == "index.json" {
			ociIndex, _ = io.ReadAll(io.LimitReader(tarReader, 8*1024*1024))
			format = "oci-archive"
		} else if strings.HasSuffix(name, ".json") && header.Size < 8*1024*1024 {
			configs[name], _ = io.ReadAll(io.LimitReader(tarReader, 8*1024*1024))
		}
	}
	var refs []string
	archSet := make(map[string]struct{})
	for _, item := range manifest {
		refs = append(refs, item.RepoTags...)
		if data := configs[item.Config]; len(data) > 0 {
			var cfg struct {
				Architecture string `json:"architecture"`
			}
			if json.Unmarshal(data, &cfg) == nil && cfg.Architecture != "" {
				archSet[cfg.Architecture] = struct{}{}
			}
		}
	}
	if len(manifest) == 0 && len(ociIndex) == 0 {
		return nil, nil, "", errors.New("file is not a Docker save or OCI image archive")
	}
	if len(ociIndex) > 0 {
		var index struct {
			Manifests []struct {
				Annotations map[string]string `json:"annotations"`
				Platform    struct {
					Architecture string `json:"architecture"`
				} `json:"platform"`
			} `json:"manifests"`
		}
		if json.Unmarshal(ociIndex, &index) == nil {
			for _, item := range index.Manifests {
				if ref := item.Annotations["org.opencontainers.image.ref.name"]; ref != "" {
					refs = append(refs, ref)
				}
				if item.Platform.Architecture != "" {
					archSet[item.Platform.Architecture] = struct{}{}
				}
			}
		}
	}
	architectures := make([]string, 0, len(archSet))
	for arch := range archSet {
		architectures = append(architectures, arch)
	}
	return unique(refs), architectures, format, nil
}

func unique(values []string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; !ok && value != "" {
			seen[value] = struct{}{}
			result = append(result, value)
		}
	}
	return result
}
