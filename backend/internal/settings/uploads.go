package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/pika/db-mock/internal/domain"
)

const (
	MiB                     int64 = 1024 * 1024
	GiB                     int64 = 1024 * MiB
	MinUploadBytes                = MiB
	MaxUploadBytes                = 1024 * GiB
	DefaultUploadBytes            = 50 * GiB
	MinUploadChunkBytes           = MiB
	MaxUploadChunkBytes           = 32 * MiB
	DefaultUploadChunkBytes       = 8 * MiB
)

type UploadPolicy struct {
	MaxBytes   int64 `json:"maxBytes"`
	ChunkBytes int64 `json:"chunkBytes"`
}

func DefaultUploadPolicy(maxAllowedBytes int64) UploadPolicy {
	if maxAllowedBytes < MinUploadBytes || maxAllowedBytes > MaxUploadBytes {
		maxAllowedBytes = DefaultUploadBytes
	}
	maxBytes := min(DefaultUploadBytes, maxAllowedBytes)
	chunkBytes := min(DefaultUploadChunkBytes, maxBytes)
	return UploadPolicy{MaxBytes: maxBytes, ChunkBytes: chunkBytes}
}

func DecodeUploadPolicy(raw json.RawMessage, defaults UploadPolicy, maxAllowedBytes int64) (UploadPolicy, error) {
	policy := defaults
	if len(bytes.TrimSpace(raw)) == 0 {
		return policy, validateUploadPolicy(policy, maxAllowedBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return defaults, fmt.Errorf("%w: invalid upload policy: %v", domain.ErrInvalid, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return defaults, fmt.Errorf("%w: upload policy must contain one JSON object", domain.ErrInvalid)
	}
	if err := validateUploadPolicy(policy, maxAllowedBytes); err != nil {
		return defaults, err
	}
	return policy, nil
}

func NormalizeUploadPolicy(raw json.RawMessage, maxAllowedBytes int64) (json.RawMessage, error) {
	policy, err := DecodeUploadPolicy(raw, DefaultUploadPolicy(maxAllowedBytes), maxAllowedBytes)
	if err != nil {
		return nil, err
	}
	result, err := json.Marshal(policy)
	if err != nil {
		return nil, fmt.Errorf("marshal upload policy: %w", err)
	}
	return result, nil
}

func validateUploadPolicy(policy UploadPolicy, maxAllowedBytes int64) error {
	switch {
	case maxAllowedBytes < MinUploadBytes || maxAllowedBytes > MaxUploadBytes:
		return fmt.Errorf("%w: deployment upload ceiling must be between %d and %d bytes", domain.ErrInvalid, MinUploadBytes, MaxUploadBytes)
	case policy.MaxBytes < MinUploadBytes || policy.MaxBytes > maxAllowedBytes:
		return fmt.Errorf("%w: upload limit must be between %d and the deployment ceiling of %d bytes", domain.ErrInvalid, MinUploadBytes, maxAllowedBytes)
	case policy.ChunkBytes < MinUploadChunkBytes || policy.ChunkBytes > MaxUploadChunkBytes:
		return fmt.Errorf("%w: upload chunk size must be between %d and %d bytes", domain.ErrInvalid, MinUploadChunkBytes, MaxUploadChunkBytes)
	case policy.ChunkBytes > policy.MaxBytes:
		return fmt.Errorf("%w: upload chunk size cannot exceed the upload limit", domain.ErrInvalid)
	default:
		return nil
	}
}
