package settings

import (
	"encoding/json"
	"testing"
)

func TestDecodeUploadPolicyUsesDefaultsAndPreservesConfiguredValues(t *testing.T) {
	defaults := DefaultUploadPolicy(100 * GiB)
	policy, err := DecodeUploadPolicy(json.RawMessage(`{"maxBytes":10737418240,"chunkBytes":4194304}`), defaults, 100*GiB)
	if err != nil {
		t.Fatal(err)
	}
	if policy.MaxBytes != 10*GiB || policy.ChunkBytes != 4*MiB {
		t.Fatalf("unexpected upload policy: %#v", policy)
	}
	policy, err = DecodeUploadPolicy(nil, defaults, 100*GiB)
	if err != nil || policy != defaults {
		t.Fatalf("empty setting should use defaults, got %#v, %v", policy, err)
	}
}

func TestNormalizeUploadPolicyRejectsUnsafeValues(t *testing.T) {
	invalid := []string{
		`{"maxBytes":1048575,"chunkBytes":1048576}`,
		`{"maxBytes":107374182401,"chunkBytes":8388608}`,
		`{"maxBytes":1073741824,"chunkBytes":524288}`,
		`{"maxBytes":2097152,"chunkBytes":4194304}`,
		`{"maxBytes":"large","chunkBytes":8388608}`,
		`{"maxBytes":1073741824,"chunkBytes":8388608,"unknown":true}`,
	}
	for _, raw := range invalid {
		if _, err := NormalizeUploadPolicy(json.RawMessage(raw), 100*GiB); err == nil {
			t.Fatalf("expected invalid upload policy to be rejected: %s", raw)
		}
	}
}

func TestDefaultUploadPolicyHonorsDeploymentCeiling(t *testing.T) {
	policy := DefaultUploadPolicy(10 * GiB)
	if policy.MaxBytes != 10*GiB || policy.ChunkBytes != DefaultUploadChunkBytes {
		t.Fatalf("unexpected ceiling-limited policy: %#v", policy)
	}
	policy = DefaultUploadPolicy(4 * MiB)
	if policy.MaxBytes != 4*MiB || policy.ChunkBytes != 4*MiB {
		t.Fatalf("chunk size should fit a small deployment ceiling: %#v", policy)
	}
}
