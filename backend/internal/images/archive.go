package images

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const maxArchiveMetadataBytes = 8 * 1024 * 1024
const maxArchiveMetadataTotalBytes = 64 * 1024 * 1024

var (
	errIncompleteDockerArchive = errors.New("docker save archive is incomplete")
	errIncompleteOCIArchive    = errors.New("OCI image archive is incomplete")
	errMissingImageReference   = errors.New("image archive does not declare a usable image reference")
	errMissingArchitecture     = errors.New("image archive does not declare a supported architecture")
)

type archiveEntry struct {
	size   int64
	data   []byte
	prefix []byte
	sha256 string
}

type archivePrefixWriter struct {
	buffer    bytes.Buffer
	remaining int
}

func (w *archivePrefixWriter) Write(data []byte) (int, error) {
	written := len(data)
	if w.remaining > 0 {
		keep := min(len(data), w.remaining)
		_, _ = w.buffer.Write(data[:keep])
		w.remaining -= keep
	}
	return written, nil
}

type dockerManifestItem struct {
	Config   string   `json:"Config"`
	RepoTags []string `json:"RepoTags"`
	Layers   []string `json:"Layers"`
}

type imageConfig struct {
	Architecture string `json:"architecture"`
	OS           string `json:"os"`
	RootFS       struct {
		Type    string   `json:"type"`
		DiffIDs []string `json:"diff_ids"`
	} `json:"rootfs"`
}

type ociDescriptor struct {
	MediaType   string            `json:"mediaType"`
	Digest      string            `json:"digest"`
	Size        int64             `json:"size"`
	Annotations map[string]string `json:"annotations"`
	Platform    struct {
		Architecture string `json:"architecture"`
		OS           string `json:"os"`
	} `json:"platform"`
}

type ociIndex struct {
	SchemaVersion int             `json:"schemaVersion"`
	Manifests     []ociDescriptor `json:"manifests"`
}

type ociManifest struct {
	SchemaVersion int             `json:"schemaVersion"`
	Config        ociDescriptor   `json:"config"`
	Layers        []ociDescriptor `json:"layers"`
}

func inspectArchive(filename string) ([]string, []string, string, error) {
	entries, err := readArchiveEntries(filename)
	if err != nil {
		return nil, nil, "", err
	}
	_, dockerArchive := entries["manifest.json"]
	_, ociArchive := entries["index.json"]
	if dockerArchive == ociArchive {
		return nil, nil, "", errors.New("file is not a Docker save or OCI image archive")
	}
	var refs, architectures []string
	format := "docker-archive"
	if dockerArchive {
		refs, architectures, err = validateDockerArchive(entries)
	} else {
		format = "oci-archive"
		refs, architectures, err = validateOCIArchive(entries)
	}
	if err != nil {
		return nil, nil, "", err
	}
	refs = uniqueSorted(refs)
	architectures = uniqueSorted(architectures)
	if len(refs) == 0 {
		return nil, nil, "", errMissingImageReference
	}
	if len(architectures) == 0 {
		return nil, nil, "", errMissingArchitecture
	}
	return refs, architectures, format, nil
}

func readArchiveEntries(filename string) (map[string]archiveEntry, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	var reader io.Reader = file
	magic := make([]byte, 2)
	_, _ = io.ReadFull(file, magic)
	_, _ = file.Seek(0, io.SeekStart)
	if len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gzipReader, openErr := gzip.NewReader(file)
		if openErr != nil {
			return nil, openErr
		}
		defer gzipReader.Close()
		reader = gzipReader
	}
	entries := make(map[string]archiveEntry)
	var metadataBytes int64
	tarReader := tar.NewReader(reader)
	for {
		header, nextErr := tarReader.Next()
		if nextErr == io.EOF {
			break
		}
		if nextErr != nil {
			return nil, fmt.Errorf("read image archive: %w", nextErr)
		}
		if header.Typeflag != tar.TypeReg {
			continue
		}
		name, valid := archivePath(header.Name)
		if !valid {
			return nil, errors.New("image archive contains an invalid path")
		}
		blobCandidate := header.Size <= maxArchiveMetadataBytes && strings.HasPrefix(name, "blobs/")
		keepData := header.Size <= maxArchiveMetadataBytes && (name == "manifest.json" || name == "index.json" || name == "oci-layout" || strings.HasSuffix(name, ".json") || blobCandidate)
		var buffer bytes.Buffer
		prefix := &archivePrefixWriter{remaining: 1024}
		var hash io.Writer
		var digestHash = sha256.New()
		if strings.HasPrefix(name, "blobs/") || dockerConfigDigestName(name) != "" {
			hash = digestHash
		}
		writers := make([]io.Writer, 0, 3)
		writers = append(writers, prefix)
		if hash != nil {
			writers = append(writers, hash)
		}
		if keepData {
			writers = append(writers, &buffer)
		}
		if len(writers) == 0 {
			writers = append(writers, io.Discard)
		}
		written, copyErr := io.Copy(io.MultiWriter(writers...), tarReader)
		if copyErr != nil || written != header.Size {
			return nil, errors.New("image archive contains a truncated entry")
		}
		entry := archiveEntry{size: header.Size, prefix: prefix.buffer.Bytes()}
		if hash != nil {
			entry.sha256 = hex.EncodeToString(digestHash.Sum(nil))
		}
		if blobCandidate && !looksLikeJSON(buffer.Bytes()) {
			keepData = false
		}
		if keepData {
			metadataBytes += int64(buffer.Len())
			if metadataBytes > maxArchiveMetadataTotalBytes {
				return nil, errors.New("image archive metadata is too large")
			}
			entry.data = buffer.Bytes()
		}
		entries[name] = entry
	}
	return entries, nil
}

func validateDockerArchive(entries map[string]archiveEntry) ([]string, []string, error) {
	manifestEntry := entries["manifest.json"]
	if len(manifestEntry.data) == 0 {
		return nil, nil, errIncompleteDockerArchive
	}
	var manifest []dockerManifestItem
	if json.Unmarshal(manifestEntry.data, &manifest) != nil || len(manifest) == 0 {
		return nil, nil, errIncompleteDockerArchive
	}
	var refs, architectures []string
	for _, item := range manifest {
		configName, valid := archivePath(item.Config)
		if !valid {
			return nil, nil, errIncompleteDockerArchive
		}
		configEntry, exists := entries[configName]
		if !exists || len(configEntry.data) == 0 {
			return nil, nil, errIncompleteDockerArchive
		}
		if expectedDigest := dockerConfigDigestName(configName); expectedDigest != "" && configEntry.sha256 != expectedDigest {
			return nil, nil, errIncompleteDockerArchive
		}
		var config imageConfig
		if json.Unmarshal(configEntry.data, &config) != nil || config.Architecture == "" || config.OS == "" || config.RootFS.Type != "layers" || len(config.RootFS.DiffIDs) != len(item.Layers) {
			return nil, nil, errIncompleteDockerArchive
		}
		for _, diffID := range config.RootFS.DiffIDs {
			if !validDigest(diffID) {
				return nil, nil, errIncompleteDockerArchive
			}
		}
		for _, layer := range item.Layers {
			layerName, layerPathValid := archivePath(layer)
			entry, exists := entries[layerName]
			if !layerPathValid || !exists || entry.size <= 0 || !looksLikeTar(entry.prefix) {
				return nil, nil, errIncompleteDockerArchive
			}
		}
		refs = append(refs, item.RepoTags...)
		architectures = append(architectures, config.Architecture)
	}
	return refs, architectures, nil
}

func validateOCIArchive(entries map[string]archiveEntry) ([]string, []string, error) {
	layoutEntry, layoutExists := entries["oci-layout"]
	indexEntry := entries["index.json"]
	var layout struct {
		Version string `json:"imageLayoutVersion"`
	}
	var index ociIndex
	if !layoutExists || json.Unmarshal(layoutEntry.data, &layout) != nil || layout.Version != "1.0.0" || json.Unmarshal(indexEntry.data, &index) != nil || index.SchemaVersion != 2 || len(index.Manifests) == 0 {
		return nil, nil, errIncompleteOCIArchive
	}
	var refs, architectures []string
	visiting := make(map[string]bool)
	for _, descriptor := range index.Manifests {
		descriptorRefs, descriptorArchitectures, err := validateOCIDescriptor(entries, descriptor, "", visiting)
		if err != nil {
			return nil, nil, err
		}
		refs = append(refs, descriptorRefs...)
		architectures = append(architectures, descriptorArchitectures...)
	}
	return refs, architectures, nil
}

func validateOCIDescriptor(entries map[string]archiveEntry, descriptor ociDescriptor, inheritedRef string, visiting map[string]bool) ([]string, []string, error) {
	entry, ok := entryForDescriptor(entries, descriptor)
	if !ok || len(entry.data) == 0 || visiting[descriptor.Digest] {
		return nil, nil, errIncompleteOCIArchive
	}
	visiting[descriptor.Digest] = true
	defer delete(visiting, descriptor.Digest)
	ref := inheritedRef
	if annotated := descriptor.Annotations["org.opencontainers.image.ref.name"]; annotated != "" {
		ref = annotated
	}
	var nested ociIndex
	if json.Unmarshal(entry.data, &nested) == nil && nested.SchemaVersion == 2 && len(nested.Manifests) > 0 {
		var refs, architectures []string
		for _, child := range nested.Manifests {
			childRefs, childArchitectures, err := validateOCIDescriptor(entries, child, ref, visiting)
			if err != nil {
				return nil, nil, err
			}
			refs = append(refs, childRefs...)
			architectures = append(architectures, childArchitectures...)
		}
		return refs, architectures, nil
	}
	var manifest ociManifest
	if json.Unmarshal(entry.data, &manifest) != nil || manifest.SchemaVersion != 2 || manifest.Config.Digest == "" {
		return nil, nil, errIncompleteOCIArchive
	}
	configEntry, ok := entryForDescriptor(entries, manifest.Config)
	if !ok || len(configEntry.data) == 0 {
		return nil, nil, errIncompleteOCIArchive
	}
	var config imageConfig
	if json.Unmarshal(configEntry.data, &config) != nil || config.Architecture == "" || config.OS == "" || config.RootFS.Type != "layers" || len(config.RootFS.DiffIDs) != len(manifest.Layers) {
		return nil, nil, errIncompleteOCIArchive
	}
	for _, diffID := range config.RootFS.DiffIDs {
		if !validDigest(diffID) {
			return nil, nil, errIncompleteOCIArchive
		}
	}
	for _, layer := range manifest.Layers {
		layerEntry, exists := entryForDescriptor(entries, layer)
		if !exists || layerEntry.size <= 0 || !validOCILayer(layer.MediaType, layerEntry.prefix) {
			return nil, nil, errIncompleteOCIArchive
		}
	}
	architecture := descriptor.Platform.Architecture
	if architecture == "" {
		architecture = config.Architecture
	}
	refs := []string{}
	if ref != "" {
		refs = append(refs, ref)
	}
	return refs, []string{architecture}, nil
}

func entryForDescriptor(entries map[string]archiveEntry, descriptor ociDescriptor) (archiveEntry, bool) {
	algorithm, encoded, ok := parseDigest(descriptor.Digest)
	if !ok || algorithm != "sha256" {
		return archiveEntry{}, false
	}
	entry, exists := entries["blobs/"+algorithm+"/"+encoded]
	if !exists || entry.sha256 != encoded || (descriptor.Size > 0 && entry.size != descriptor.Size) {
		return archiveEntry{}, false
	}
	return entry, true
}

func validDigest(value string) bool {
	algorithm, _, ok := parseDigest(value)
	return ok && algorithm == "sha256"
}

func parseDigest(value string) (string, string, bool) {
	algorithm, encoded, found := strings.Cut(strings.ToLower(value), ":")
	if !found || algorithm == "" || len(encoded) != sha256.Size*2 {
		return "", "", false
	}
	if _, err := hex.DecodeString(encoded); err != nil {
		return "", "", false
	}
	return algorithm, encoded, true
}

func archivePath(value string) (string, bool) {
	name := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(value)), "./")
	if name == "" || strings.HasPrefix(name, "/") || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "/../") {
		return "", false
	}
	return name, true
}

func dockerConfigDigestName(name string) string {
	base := strings.TrimSuffix(filepath.Base(name), ".json")
	if len(base) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(base); err != nil {
		return ""
	}
	return strings.ToLower(base)
}

func looksLikeTar(prefix []byte) bool {
	if len(prefix) < 512 {
		return false
	}
	_, err := tar.NewReader(bytes.NewReader(prefix)).Next()
	return err == nil || err == io.EOF
}

func validOCILayer(mediaType string, prefix []byte) bool {
	mediaType = strings.ToLower(mediaType)
	switch {
	case strings.Contains(mediaType, "gzip"):
		return len(prefix) >= 2 && prefix[0] == 0x1f && prefix[1] == 0x8b
	case strings.Contains(mediaType, "zstd"):
		return len(prefix) >= 4 && prefix[0] == 0x28 && prefix[1] == 0xb5 && prefix[2] == 0x2f && prefix[3] == 0xfd
	default:
		return looksLikeTar(prefix)
	}
}

func looksLikeJSON(data []byte) bool {
	data = bytes.TrimSpace(data)
	return len(data) > 0 && (data[0] == '{' || data[0] == '[')
}

func uniqueSorted(values []string) []string {
	seen := make(map[string]struct{})
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
