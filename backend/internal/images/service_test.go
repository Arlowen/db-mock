package images

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
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

func TestRemoveUploadTemporaryFileOnlyRemovesManagedParts(t *testing.T) {
	directory := t.TempDir()
	service := New(nil, directory, 0)
	managed := filepath.Join(directory, "uploads", uuid.NewString()+".part")
	if err := os.MkdirAll(filepath.Dir(managed), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managed, []byte("partial archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.removeUploadTemporaryFile(managed); err != nil {
		t.Fatalf("remove managed part: %v", err)
	}
	if _, err := os.Stat(managed); !os.IsNotExist(err) {
		t.Fatalf("managed part still exists or stat failed unexpectedly: %v", err)
	}

	external := filepath.Join(t.TempDir(), uuid.NewString()+".part")
	if err := os.WriteFile(external, []byte("must remain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.removeUploadTemporaryFile(external); err == nil {
		t.Fatal("expected an external path to be rejected")
	}
	if _, err := os.Stat(external); err != nil {
		t.Fatalf("external file was changed: %v", err)
	}

	invalid := filepath.Join(directory, "uploads", "not-an-upload.part")
	if err := os.WriteFile(invalid, []byte("must remain"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := service.removeUploadTemporaryFile(invalid); err == nil {
		t.Fatal("expected an invalid managed filename to be rejected")
	}
	if _, err := os.Stat(invalid); err != nil {
		t.Fatalf("invalidly named file was changed: %v", err)
	}
}
