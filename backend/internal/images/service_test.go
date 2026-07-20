package images

import (
	"encoding/json"
	"testing"

	platformsettings "github.com/pika/db-mock/internal/settings"
)

func TestResolveUploadPolicyUsesRuntimeSetting(t *testing.T) {
	values := map[string]json.RawMessage{
		"uploads": json.RawMessage(`{"maxBytes":10737418240,"chunkBytes":4194304}`),
	}
	policy := resolveUploadPolicy(values, 20*platformsettings.GiB)
	if policy.MaxBytes != 10*platformsettings.GiB || policy.ChunkBytes != 4*platformsettings.MiB {
		t.Fatalf("unexpected runtime upload policy: %#v", policy)
	}
}

func TestResolveUploadPolicyFallsBackWhenStoredValueExceedsDeploymentCeiling(t *testing.T) {
	values := map[string]json.RawMessage{
		"uploads": json.RawMessage(`{"maxBytes":53687091200,"chunkBytes":8388608}`),
	}
	policy := resolveUploadPolicy(values, 10*platformsettings.GiB)
	if policy.MaxBytes != 10*platformsettings.GiB || policy.ChunkBytes != platformsettings.DefaultUploadChunkBytes {
		t.Fatalf("unexpected fallback upload policy: %#v", policy)
	}
}
