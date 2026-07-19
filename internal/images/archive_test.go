package images

import (
	"archive/tar"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func TestInspectDockerArchiveValidatesEveryReferencedEntry(t *testing.T) {
	layer := nestedTar(t, "database.sql", []byte("database image layer"))
	config := dockerConfig(t, "amd64", 1)
	configName := blobPath(digest(config))[len("blobs/sha256/"):] + ".json"
	manifest := marshalJSON(t, []dockerManifestItem{{Config: configName, RepoTags: []string{"postgres:17-alpine"}, Layers: []string{"layer.tar"}}})
	filename := writeTar(t, map[string][]byte{"manifest.json": manifest, configName: config, "layer.tar": layer})

	refs, architectures, format, err := inspectArchive(filename)
	if err != nil {
		t.Fatalf("inspect valid Docker archive: %v", err)
	}
	if format != "docker-archive" {
		t.Fatalf("expected docker-archive, got %q", format)
	}
	if len(refs) != 1 || refs[0] != "postgres:17-alpine" {
		t.Fatalf("unexpected refs: %#v", refs)
	}
	if len(architectures) != 1 || architectures[0] != "amd64" {
		t.Fatalf("unexpected architectures: %#v", architectures)
	}
}

func TestInspectDockerArchiveRejectsMissingLayer(t *testing.T) {
	config := dockerConfig(t, "arm64", 1)
	manifest := marshalJSON(t, []dockerManifestItem{{Config: "config.json", RepoTags: []string{"postgres:17-alpine"}, Layers: []string{"missing-layer.tar"}}})
	filename := writeTar(t, map[string][]byte{"manifest.json": manifest, "config.json": config})

	_, _, _, err := inspectArchive(filename)
	if !errors.Is(err, errIncompleteDockerArchive) {
		t.Fatalf("expected incomplete Docker archive, got %v", err)
	}
}

func TestInspectDockerArchiveRejectsMissingImageReference(t *testing.T) {
	config := dockerConfig(t, "amd64", 1)
	manifest := marshalJSON(t, []dockerManifestItem{{Config: "config.json", Layers: []string{"layer.tar"}}})
	filename := writeTar(t, map[string][]byte{"manifest.json": manifest, "config.json": config, "layer.tar": nestedTar(t, "data", []byte("layer"))})

	_, _, _, err := inspectArchive(filename)
	if !errors.Is(err, errMissingImageReference) {
		t.Fatalf("expected missing image reference, got %v", err)
	}
}

func TestInspectOCIArchiveValidatesDescriptorsAndBlobDigests(t *testing.T) {
	layer := nestedTar(t, "database.sql", []byte("compressed image layer"))
	config := dockerConfig(t, "arm64", 1)
	configDigest := digest(config)
	layerDigest := digest(layer)
	manifest := marshalJSON(t, ociManifest{
		SchemaVersion: 2,
		Config:        ociDescriptor{Digest: configDigest, Size: int64(len(config))},
		Layers:        []ociDescriptor{{MediaType: "application/vnd.oci.image.layer.v1.tar", Digest: layerDigest, Size: int64(len(layer))}},
	})
	manifestDigest := digest(manifest)
	index := marshalJSON(t, ociIndex{SchemaVersion: 2, Manifests: []ociDescriptor{{
		Digest: manifestDigest,
		Size:   int64(len(manifest)),
		Annotations: map[string]string{
			"org.opencontainers.image.ref.name": "postgres:17-alpine",
		},
		Platform: struct {
			Architecture string `json:"architecture"`
			OS           string `json:"os"`
		}{Architecture: "arm64", OS: "linux"},
	}}})
	filename := writeTar(t, map[string][]byte{
		"oci-layout":             []byte(`{"imageLayoutVersion":"1.0.0"}`),
		"index.json":             index,
		blobPath(manifestDigest): manifest,
		blobPath(configDigest):   config,
		blobPath(layerDigest):    layer,
	})

	refs, architectures, format, err := inspectArchive(filename)
	if err != nil {
		t.Fatalf("inspect valid OCI archive: %v", err)
	}
	if format != "oci-archive" || len(refs) != 1 || refs[0] != "postgres:17-alpine" || len(architectures) != 1 || architectures[0] != "arm64" {
		t.Fatalf("unexpected OCI result: format=%q refs=%#v architectures=%#v", format, refs, architectures)
	}
}

func TestInspectOCIArchiveRejectsBlobWithWrongDigest(t *testing.T) {
	config := dockerConfig(t, "amd64", 0)
	configDigest := digest(config)
	manifest := marshalJSON(t, ociManifest{SchemaVersion: 2, Config: ociDescriptor{Digest: configDigest, Size: int64(len(config))}})
	manifestDigest := digest(manifest)
	index := marshalJSON(t, ociIndex{SchemaVersion: 2, Manifests: []ociDescriptor{{Digest: manifestDigest, Size: int64(len(manifest)), Annotations: map[string]string{"org.opencontainers.image.ref.name": "postgres:17-alpine"}}}})
	filename := writeTar(t, map[string][]byte{
		"oci-layout":             []byte(`{"imageLayoutVersion":"1.0.0"}`),
		"index.json":             index,
		blobPath(manifestDigest): []byte("tampered manifest"),
		blobPath(configDigest):   config,
	})

	_, _, _, err := inspectArchive(filename)
	if !errors.Is(err, errIncompleteOCIArchive) {
		t.Fatalf("expected incomplete OCI archive, got %v", err)
	}
}

func dockerConfig(t *testing.T, architecture string, layers int) []byte {
	t.Helper()
	config := imageConfig{Architecture: architecture, OS: "linux"}
	config.RootFS.Type = "layers"
	for index := 0; index < layers; index++ {
		value := sha256.Sum256([]byte{byte(index)})
		config.RootFS.DiffIDs = append(config.RootFS.DiffIDs, "sha256:"+hex.EncodeToString(value[:]))
	}
	return marshalJSON(t, config)
}

func marshalJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeTar(t *testing.T, entries map[string][]byte) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "image.tar")
	file, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		data := entries[name]
		if err = writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data))}); err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err = file.Close(); err != nil {
		t.Fatal(err)
	}
	return filename
}

func nestedTar(t *testing.T, name string, data []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data))}); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func digest(data []byte) string {
	value := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(value[:])
}

func blobPath(value string) string {
	_, encoded, _ := parseDigest(value)
	return "blobs/sha256/" + encoded
}
