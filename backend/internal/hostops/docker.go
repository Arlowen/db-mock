package hostops

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

const DockerUnavailableMessage = "Docker Engine or Compose v2 is not available"

type Docker struct {
	runner Runner
}

type ContainerMetric struct {
	InstanceID    string
	Status        string
	Health        string
	CPUPercent    float64
	MemoryBytes   int64
	MemoryPercent float64
}

type ManagedState struct {
	State  string
	Health string
}

type BackupArchiveInfo struct {
	Path      string
	SizeBytes int64
	SHA256    string
}

func NewDocker(runner Runner) *Docker { return &Docker{runner: runner} }

func (d *Docker) Probe(ctx context.Context, host domain.Host) (ProbeResult, error) {
	return d.runner.Probe(ctx, host)
}

func (d *Docker) ListeningTCPPorts(ctx context.Context, host domain.Host) (map[int]struct{}, error) {
	const command = `set -eu
if command -v ss >/dev/null 2>&1; then
  ss -H -ltn 2>/dev/null | awk '{print $4}'
elif command -v lsof >/dev/null 2>&1; then
  lsof -nP -a -iTCP -sTCP:LISTEN -F n 2>/dev/null | sed -n 's/^n//p'
elif command -v netstat >/dev/null 2>&1; then
  netstat -an 2>/dev/null | awk '/LISTEN/{print $4}'
else
  echo 'ss, lsof, or netstat is required to inspect listening TCP ports' >&2
  exit 69
fi`
	probeCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	result, err := d.runner.Run(probeCtx, host, command, nil)
	if err != nil {
		return nil, fmt.Errorf("inspect listening TCP ports: %w", err)
	}
	return parseListeningTCPPorts(result.Stdout), nil
}

func parseListeningTCPPorts(output string) map[int]struct{} {
	ports := make(map[int]struct{})
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			continue
		}
		endpoint := fields[0]
		separator := strings.LastIndexAny(endpoint, ":.")
		if separator < 0 || separator == len(endpoint)-1 {
			continue
		}
		port, err := strconv.Atoi(endpoint[separator+1:])
		if err == nil && port >= 1 && port <= 65535 {
			ports[port] = struct{}{}
		}
	}
	return ports
}

func (d *Docker) InstallOrUpgrade(ctx context.Context, host domain.Host, upgrade bool) (CommandResult, error) {
	if host.OS != "" && host.OS != "linux" {
		return CommandResult{}, errors.New("automatic Docker installation is supported only on Linux")
	}
	proxy := proxyPrefix(host)
	aptMode := "install"
	rpmMode := "install"
	if upgrade {
		aptMode = "install --only-upgrade"
		rpmMode = "upgrade"
	}
	script := `set -eu
if ! sudo -n true; then echo 'passwordless sudo is required' >&2; exit 77; fi
if [ ! -r /etc/os-release ]; then echo 'unsupported Linux distribution' >&2; exit 78; fi
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian)
    sudo -n apt-get update
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get ` + aptMode + ` -y docker.io docker-compose-v2 2>/dev/null ||
      sudo -n env DEBIAN_FRONTEND=noninteractive apt-get ` + aptMode + ` -y docker.io docker-compose-plugin
    ;;
  rocky|almalinux|rhel|centos)
    sudo -n dnf -y install dnf-plugins-core
    if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
      sudo -n dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    fi
    sudo -n dnf -y ` + rpmMode + ` docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    ;;
  *) echo "unsupported Linux distribution: ${ID:-unknown}" >&2; exit 78 ;;
esac
sudo -n systemctl enable --now docker
sudo -n usermod -aG docker "$USER" || true
docker version --format '{{.Server.Version}}' || sudo -n docker version --format '{{.Server.Version}}'
docker compose version --short || sudo -n docker compose version --short`
	return d.runner.Run(ctx, host, proxy+script, nil)
}

func (d *Docker) ConfigureProxy(ctx context.Context, host domain.Host) error {
	if host.OS != "linux" {
		return errors.New("configure the Docker Desktop proxy in macOS settings")
	}
	if !host.ManageDocker {
		return errors.New("Docker management is disabled for this host")
	}
	directory := "/etc/systemd/system/docker.service.d"
	if host.ProxyHTTP == "" && host.ProxyHTTPS == "" && host.ProxyNoProxy == "" {
		_, err := d.runner.Run(ctx, host, `set -eu; sudo -n rm -f /etc/systemd/system/docker.service.d/dbmock-proxy.conf; sudo -n systemctl daemon-reload; sudo -n systemctl restart docker`, nil)
		return err
	}
	lines := []string{"[Service]"}
	for _, item := range []struct{ key, value string }{{"HTTP_PROXY", host.ProxyHTTP}, {"HTTPS_PROXY", host.ProxyHTTPS}, {"NO_PROXY", host.ProxyNoProxy}} {
		if item.value != "" {
			value := strings.ReplaceAll(strings.ReplaceAll(strings.ReplaceAll(item.value, `\`, `\\`), `"`, `\"`), `%`, `%%`)
			lines = append(lines, `Environment="`+item.key+`=`+value+`"`)
		}
	}
	temporary := "/tmp/dbmock-docker-proxy.conf"
	if err := d.runner.WriteFile(ctx, host, temporary, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	command := `set -eu; sudo -n mkdir -p ` + ShellQuote(directory) + `; sudo -n install -m 0644 ` + ShellQuote(temporary) +
		` ` + ShellQuote(path.Join(directory, "dbmock-proxy.conf")) + `; rm -f ` + ShellQuote(temporary) +
		`; sudo -n systemctl daemon-reload; sudo -n systemctl restart docker`
	_, err := d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) LoginRegistry(ctx context.Context, host domain.Host, registry, username, password string) error {
	if username == "" || password == "" {
		return nil
	}
	server := registryServer(registry)
	command := "docker login " + ShellQuote(server) + " --username " + ShellQuote(username) + " --password-stdin"
	_, err := d.runner.Run(ctx, host, command, strings.NewReader(password+"\n"))
	return err
}

func registryServer(value string) string {
	return strings.TrimPrefix(strings.TrimPrefix(strings.TrimSuffix(value, "/"), "https://"), "http://")
}

func (d *Docker) InstallRegistryCA(ctx context.Context, host domain.Host, registry, certificate string) error {
	if certificate == "" {
		return nil
	}
	temporary := "/tmp/dbmock-registry-ca-" + SHA256Fingerprint([]byte(registry)) + ".crt"
	if err := d.runner.WriteFile(ctx, host, temporary, []byte(certificate), 0o600); err != nil {
		return err
	}
	registryName := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSuffix(registry, "/"), "https://"), "http://")
	if host.OS == "darwin" {
		directory := "$HOME/.docker/certs.d/" + ShellQuote(registryName)
		command := `set -eu; mkdir -p ` + directory + `; install -m 0644 ` + ShellQuote(temporary) + ` ` + directory +
			`/ca.crt; rm -f ` + ShellQuote(temporary) + `; osascript -e 'quit app "Docker"' >/dev/null 2>&1 || true; open -a Docker; ` +
			`for i in $(seq 1 120); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1`
		_, err := d.runner.Run(ctx, host, command, nil)
		return err
	}
	directory := "/etc/docker/certs.d/" + registryName
	command := `set -eu; sudo -n mkdir -p ` + ShellQuote(directory) + `; sudo -n install -m 0644 ` +
		ShellQuote(temporary) + ` ` + ShellQuote(path.Join(directory, "ca.crt")) + `; rm -f ` + ShellQuote(temporary) +
		`; sudo -n systemctl restart docker`
	_, err := d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) PullImage(ctx context.Context, host domain.Host, image string) error {
	_, err := d.runner.Run(ctx, host, proxyPrefix(host)+"docker pull "+ShellQuote(image), nil)
	return err
}

func (d *Docker) LoadImage(ctx context.Context, host domain.Host, localPath string, progress func(int64, int64)) error {
	remote := "/tmp/dbmock-image-" + SHA256Fingerprint([]byte(localPath)) + path.Ext(localPath)
	if err := d.runner.UploadFile(ctx, host, localPath, remote, progress); err != nil {
		return err
	}
	defer func() { _, _ = d.runner.Run(context.Background(), host, "rm -f "+ShellQuote(remote), nil) }()
	command := "docker load -i " + ShellQuote(remote)
	if strings.HasSuffix(strings.ToLower(localPath), ".gz") {
		command = "gzip -dc " + ShellQuote(remote) + " | docker load"
	}
	_, err := d.runner.Run(ctx, host, command, nil)
	return err
}

const managedProjectFilesManifest = ".dbmock-managed-files"

func normalizeManagedProjectFiles(files map[string][]byte) (map[string][]byte, []string, error) {
	normalized := make(map[string][]byte, len(files))
	foldedPaths := make(map[string]string, len(files))
	for name, content := range files {
		if !utf8.ValidString(name) || strings.Contains(name, "\\") || strings.ContainsAny(name, "\r\n\x00") {
			return nil, nil, fmt.Errorf("unsafe project file %q", name)
		}
		clean := path.Clean(name)
		if clean == "." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
			return nil, nil, fmt.Errorf("unsafe project file %q", name)
		}
		for _, character := range clean {
			if character < 0x20 || character == 0x7f {
				return nil, nil, fmt.Errorf("unsafe project file %q", name)
			}
		}
		component := strings.ToLower(strings.SplitN(clean, "/", 2)[0])
		if component == ".env" || component == "compose.yaml" || component == "data" || component == "runtime" ||
			strings.HasPrefix(component, ".dbmock-managed-files") {
			return nil, nil, fmt.Errorf("project file %q is owned by DB Mock", name)
		}
		folded := strings.ToLower(clean)
		if previous, exists := foldedPaths[folded]; exists {
			return nil, nil, fmt.Errorf("project files %q and %q collide on case-insensitive hosts", previous, name)
		}
		foldedPaths[folded] = clean
		normalized[clean] = content
	}
	for folded, name := range foldedPaths {
		for parent := path.Dir(folded); parent != "."; parent = path.Dir(parent) {
			if ancestor, exists := foldedPaths[parent]; exists {
				return nil, nil, fmt.Errorf("project file %q conflicts with child path %q", ancestor, name)
			}
		}
	}
	names := make([]string, 0, len(normalized))
	for name := range normalized {
		names = append(names, name)
	}
	sort.Strings(names)
	return normalized, names, nil
}

func managedProjectFileList(names []string) []byte {
	if len(names) == 0 {
		return []byte{}
	}
	return []byte(strings.Join(names, "\n") + "\n")
}

func reconcileManagedProjectFilesCommand(directory string) string {
	return `set -eu
root=` + ShellQuote(directory) + `
manifest="$root/` + managedProjectFilesManifest + `"
seed="$root/` + managedProjectFilesManifest + `.seed"
next="$root/` + managedProjectFilesManifest + `.next"
if [ ! -f "$manifest" ]; then
  mv -f -- "$seed" "$manifest"
else
  rm -f -- "$seed"
fi
while IFS= read -r managed_file || [ -n "$managed_file" ]; do
  case "$managed_file" in
    ""|/*|..|../*|*/../*|*/..) exit 1 ;;
  esac
  managed_root="${managed_file%%/*}"
  managed_root="$(printf '%s' "$managed_root" | tr '[:upper:]' '[:lower:]')"
  case "$managed_root" in
    .env|compose.yaml|data|runtime|.dbmock-managed-files*) exit 1 ;;
  esac
  if ! grep -Fqx -- "$managed_file" "$next"; then
    target="$root/$managed_file"
    rm -f -- "$target"
    parent="$(dirname "$target")"
    while [ "$parent" != "$root" ]; do
      rmdir "$parent" 2>/dev/null || break
      parent="$(dirname "$parent")"
    done
  fi
done < "$manifest"
mv -f -- "$next" "$manifest"`
}

func (d *Docker) WriteProject(ctx context.Context, host domain.Host, instance domain.Instance, compose, env []byte,
	files, previousFiles map[string][]byte) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	normalized, names, err := normalizeManagedProjectFiles(files)
	if err != nil {
		return err
	}
	_, previousNames, err := normalizeManagedProjectFiles(previousFiles)
	if err != nil {
		return err
	}
	if _, err := d.runner.Run(ctx, host, "mkdir -p "+ShellQuote(instance.RemoteDirectory), nil); err != nil {
		return err
	}
	manifest := path.Join(instance.RemoteDirectory, managedProjectFilesManifest)
	if err := d.runner.WriteFile(ctx, host, manifest+".seed", managedProjectFileList(previousNames), 0o600); err != nil {
		return err
	}
	if err := d.runner.WriteFile(ctx, host, manifest+".next", managedProjectFileList(names), 0o600); err != nil {
		return err
	}
	if _, err := d.runner.Run(ctx, host, reconcileManagedProjectFilesCommand(instance.RemoteDirectory), nil); err != nil {
		return err
	}
	if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, "compose.yaml"), compose, 0o600); err != nil {
		return err
	}
	if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, ".env"), env, 0o600); err != nil {
		return err
	}
	for _, name := range names {
		if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, name), normalized[name], 0o600); err != nil {
			return err
		}
	}
	return nil
}

func (d *Docker) ComposeUp(ctx context.Context, host domain.Host, instance domain.Instance, pull bool) error {
	base := composeCommand(instance)
	if pull {
		if _, err := d.runner.Run(ctx, host, proxyPrefix(host)+base+" pull", nil); err != nil {
			return err
		}
	}
	_, err := d.runner.Run(ctx, host, base+" up -d --remove-orphans --wait --wait-timeout 300", nil)
	return err
}

func (d *Docker) ComposeStart(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, composeCommand(instance)+" up -d --wait --wait-timeout 180", nil)
	return err
}

func (d *Docker) ValidateProject(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, composeCommand(instance)+" config --quiet", nil)
	return err
}

func (d *Docker) ComposeStop(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, composeCommand(instance)+" stop --timeout 60", nil)
	return err
}

func (d *Docker) ComposeRestart(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, composeCommand(instance)+" restart --timeout 60", nil)
	return err
}

func (d *Docker) ComposeDown(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, composeCommand(instance)+" down --volumes --remove-orphans --timeout 60", nil)
	return err
}

func (d *Docker) RemoveProject(ctx context.Context, host domain.Host, instance domain.Instance) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	_, err := d.runner.Run(ctx, host, "rm -rf -- "+ShellQuote(instance.RemoteDirectory), nil)
	return err
}

func (d *Docker) Logs(ctx context.Context, host domain.Host, instance domain.Instance, tail int) (string, error) {
	if tail <= 0 || tail > 10000 {
		tail = 500
	}
	result, err := d.runner.Run(ctx, host, composeCommand(instance)+" logs --no-color --timestamps --tail "+strconv.Itoa(tail), nil)
	return result.Stdout + result.Stderr, err
}

func archiveStreamScript(source string) string {
	return `set -eu; tar -C ` + ShellQuote(source) + ` -czf - --exclude=upgrade-snapshot.tar.gz --exclude=upgrade-snapshot.tar.gz.tmp .`
}

func restoreStreamScript(target string) string {
	return `set -eu
for item in ` + ShellQuote(target) + `/.[!.]* ` + ShellQuote(target) + `/..?* ` + ShellQuote(target) + `/*; do
  [ -e "$item" ] || [ -L "$item" ] || continue
  rm -rf -- "$item"
done
tar -C ` + ShellQuote(target) + ` -xzf -`
}

func dockerDataHelperCommand(image, volume, script string, interactive bool) (string, error) {
	image = strings.TrimSpace(image)
	if image == "" || strings.ContainsAny(image, "\r\n\x00") {
		return "", errors.New("a valid local database image is required for protected data access")
	}
	command := `docker run --rm --pull never --network none --read-only --user 0:0 --label dbmock.helper=archive --entrypoint /bin/sh`
	if interactive {
		command += " -i"
	}
	command += " --volume " + ShellQuote(volume) + " " + ShellQuote(image) + " -c " + ShellQuote(script)
	return command, nil
}

func rollbackSnapshotPath(host domain.Host, instance domain.Instance, operationID uuid.UUID) (string, error) {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return "", err
	}
	if instance.ID == uuid.Nil || operationID == uuid.Nil {
		return "", errors.New("instance and operation IDs are required for a rollback snapshot")
	}
	return path.Join(host.DataRoot, "backups", ".rollback", instance.ID.String(), operationID.String()+".tar.gz"), nil
}

func (d *Docker) SnapshotForUpgrade(ctx context.Context, host domain.Host, instance domain.Instance, operationID uuid.UUID,
	reuseExisting bool, helperImage string) (string, error) {
	snapshot, err := rollbackSnapshotPath(host, instance, operationID)
	if err != nil {
		return "", err
	}
	temporary := snapshot + ".tmp"
	directory := path.Dir(snapshot)
	helper, err := dockerDataHelperCommand(helperImage, instance.RemoteDirectory+":/source:ro", archiveStreamScript("/source"), false)
	if err != nil {
		return "", err
	}
	create := "rm -f -- " + ShellQuote(snapshot) + " " + ShellQuote(temporary) + " && " + helper + " > " +
		ShellQuote(temporary) + " && chmod 0600 " + ShellQuote(temporary) + " && mv -f -- " +
		ShellQuote(temporary) + " " + ShellQuote(snapshot)
	if reuseExisting {
		create = "if [ -e " + ShellQuote(snapshot) + " ] || [ -L " + ShellQuote(snapshot) + " ]; then " +
			"test ! -L " + ShellQuote(snapshot) + " && test -f " + ShellQuote(snapshot) + " && test -s " + ShellQuote(snapshot) +
			" && chmod 0600 " + ShellQuote(snapshot) + "; else rm -f -- " + ShellQuote(temporary) + " && " + helper + " > " +
			ShellQuote(temporary) + " && chmod 0600 " + ShellQuote(temporary) + " && mv -f -- " +
			ShellQuote(temporary) + " " + ShellQuote(snapshot) + "; fi"
	}
	command := composeCommand(instance) + " stop --timeout 120 && umask 077 && mkdir -p " + ShellQuote(directory) +
		" && test ! -L " + ShellQuote(directory) + " && chmod 0700 " + ShellQuote(directory) + " && " + create
	_, err = d.runner.Run(ctx, host, command, nil)
	if err != nil {
		_, _ = d.runner.Run(context.Background(), host, "rm -f -- "+ShellQuote(temporary), nil)
		return "", err
	}
	return snapshot, nil
}

func (d *Docker) RestoreUpgradeSnapshot(ctx context.Context, host domain.Host, instance domain.Instance, operationID uuid.UUID,
	snapshot, helperImage string) error {
	expected, err := rollbackSnapshotPath(host, instance, operationID)
	if err != nil {
		return err
	}
	if snapshot != expected {
		return errors.New("invalid upgrade snapshot path")
	}
	helper, err := dockerDataHelperCommand(helperImage, instance.RemoteDirectory+":/target", restoreStreamScript("/target"), true)
	if err != nil {
		return err
	}
	command := `set -eu; test ! -L ` + ShellQuote(snapshot) + `; test -f ` + ShellQuote(snapshot) + `; ` + helper + ` < ` + ShellQuote(snapshot)
	_, err = d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) DeleteUpgradeSnapshot(ctx context.Context, host domain.Host, instance domain.Instance, operationID uuid.UUID) error {
	snapshot, err := rollbackSnapshotPath(host, instance, operationID)
	if err != nil {
		return err
	}
	directory := path.Dir(snapshot)
	root := path.Dir(directory)
	_, err = d.runner.Run(ctx, host, `set -eu; rm -f -- `+ShellQuote(snapshot)+` `+ShellQuote(snapshot+".tmp")+
		`; rmdir `+ShellQuote(directory)+` 2>/dev/null || true; rmdir `+ShellQuote(root)+` 2>/dev/null || true`, nil)
	return err
}

func (d *Docker) DeleteInstanceRollbackSnapshots(ctx context.Context, host domain.Host, instance domain.Instance) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	if instance.ID == uuid.Nil {
		return errors.New("instance ID is required to remove rollback snapshots")
	}
	root := path.Join(host.DataRoot, "backups", ".rollback")
	directory := path.Join(root, instance.ID.String())
	legacy := path.Join(root, instance.ID.String()+".tar.gz")
	_, err := d.runner.Run(ctx, host, `set -eu; rm -rf -- `+ShellQuote(directory)+`; rm -f -- `+
		ShellQuote(legacy)+` `+ShellQuote(legacy+".tmp")+`; rmdir `+ShellQuote(root)+` 2>/dev/null || true`, nil)
	return err
}

func (d *Docker) BackupArchivePath(host domain.Host, instance domain.Instance, backupID uuid.UUID) (string, error) {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return "", err
	}
	if backupID == uuid.Nil {
		return "", errors.New("backup ID is required")
	}
	return path.Join(host.DataRoot, "backups", instance.ID.String(), backupID.String()+".tar.gz"), nil
}

func parseBackupArchiveInfo(output, archivePath string) (BackupArchiveInfo, error) {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		parts := strings.Split(strings.TrimSpace(lines[index]), "|")
		if len(parts) != 2 {
			continue
		}
		size, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
		digest := strings.ToLower(strings.TrimSpace(parts[1]))
		decoded, digestErr := hex.DecodeString(digest)
		if err == nil && size > 0 && digestErr == nil && len(decoded) == 32 {
			return BackupArchiveInfo{Path: archivePath, SizeBytes: size, SHA256: digest}, nil
		}
	}
	return BackupArchiveInfo{}, errors.New("unable to read backup archive size and checksum")
}

func backupDigestCommand(archive string) string {
	return `size="$(wc -c < ` + ShellQuote(archive) + ` | tr -d '[:space:]')"; ` +
		`if command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum ` + ShellQuote(archive) + ` | awk '{print $1}')"; ` +
		`else digest="$(shasum -a 256 ` + ShellQuote(archive) + ` | awk '{print $1}')"; fi; ` +
		`printf '%s|%s\n' "$size" "$digest"`
}

func (d *Docker) CreateBackupArchive(ctx context.Context, host domain.Host, instance domain.Instance, backupID uuid.UUID, helperImage string) (BackupArchiveInfo, error) {
	archive, err := d.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return BackupArchiveInfo{}, err
	}
	directory := path.Dir(archive)
	temporary := archive + ".tmp"
	helper, err := dockerDataHelperCommand(helperImage, instance.RemoteDirectory+":/source:ro", archiveStreamScript("/source"), false)
	if err != nil {
		return BackupArchiveInfo{}, err
	}
	command := `set -eu; umask 077; mkdir -p ` + ShellQuote(directory) + `; chmod 0700 ` + ShellQuote(directory) +
		`; rm -f -- ` + ShellQuote(temporary) + `; ` + helper + ` > ` + ShellQuote(temporary) + `; mv -f -- ` + ShellQuote(temporary) + ` ` +
		ShellQuote(archive) + `; chmod 0600 ` + ShellQuote(archive) + `; ` + backupDigestCommand(archive)
	result, err := d.runner.Run(ctx, host, command, nil)
	if err != nil {
		_, _ = d.runner.Run(context.Background(), host, "rm -f -- "+ShellQuote(temporary), nil)
		return BackupArchiveInfo{}, err
	}
	return parseBackupArchiveInfo(result.Stdout, archive)
}

func (d *Docker) InspectBackupArchive(ctx context.Context, host domain.Host, instance domain.Instance, backupID uuid.UUID) (BackupArchiveInfo, error) {
	archive, err := d.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return BackupArchiveInfo{}, err
	}
	result, err := d.runner.Run(ctx, host, `set -eu; test -f `+ShellQuote(archive)+`; `+backupDigestCommand(archive), nil)
	if err != nil {
		return BackupArchiveInfo{}, err
	}
	return parseBackupArchiveInfo(result.Stdout, archive)
}

func (d *Docker) RestoreBackupArchive(ctx context.Context, host domain.Host, instance domain.Instance, backupID uuid.UUID, helperImage string) error {
	archive, err := d.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return err
	}
	helper, err := dockerDataHelperCommand(helperImage, instance.RemoteDirectory+":/target", restoreStreamScript("/target"), true)
	if err != nil {
		return err
	}
	command := `set -eu; test -f ` + ShellQuote(archive) + `; ` + helper + ` < ` + ShellQuote(archive)
	_, err = d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) DeleteBackupArchive(ctx context.Context, host domain.Host, instance domain.Instance, backupID uuid.UUID) error {
	archive, err := d.BackupArchivePath(host, instance, backupID)
	if err != nil {
		return err
	}
	directory := path.Dir(archive)
	_, err = d.runner.Run(ctx, host, `set -eu; rm -f -- `+ShellQuote(archive)+`; rmdir `+ShellQuote(directory)+` 2>/dev/null || true`, nil)
	return err
}

func (d *Docker) ApplyTuning(ctx context.Context, host domain.Host, commands []string) error {
	for _, command := range commands {
		if strings.TrimSpace(command) == "" {
			continue
		}
		_, err := d.runner.Run(ctx, host, "sudo -n sh -c "+ShellQuote(command), nil)
		if err != nil {
			return err
		}
	}
	return nil
}

func (d *Docker) RunProjectScript(ctx context.Context, host domain.Host, instance domain.Instance, relative string) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	clean := path.Clean(relative)
	if clean == "." || path.IsAbs(clean) || strings.HasPrefix(clean, "../") {
		return errors.New("invalid project script path")
	}
	script := path.Join(instance.RemoteDirectory, clean)
	command := "chmod 0700 " + ShellQuote(script) + " && cd " + ShellQuote(instance.RemoteDirectory) + " && " + ShellQuote(script)
	_, err := d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) Metrics(ctx context.Context, host domain.Host) ([]ContainerMetric, int64, int64, error) {
	command := `set -u
for container in $(docker ps -q --filter label=dbmock.instance); do
  instance="$(docker inspect --format '{{index .Config.Labels "dbmock.instance"}}' "$container" 2>/dev/null || true)"
  stats="$(docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}' "$container" 2>/dev/null || true)"
  [ -n "$instance" ] && [ -n "$stats" ] && printf '%s|%s\n' "$instance" "$stats"
done
printf '%s\n' '__DISK__'
df -Pk ` + ShellQuote(host.DataRoot) + ` 2>/dev/null | awk 'NR==2{print $3*1024 "|" $2*1024}' || true`
	result, err := d.runner.Run(ctx, host, command, nil)
	if err != nil {
		return nil, 0, 0, err
	}
	var metrics []ContainerMetric
	var diskUsed, diskTotal int64
	disk := false
	for _, line := range strings.Split(result.Stdout, "\n") {
		if line == "__DISK__" {
			disk = true
			continue
		}
		if strings.TrimSpace(line) == "" {
			continue
		}
		if disk {
			parts := strings.Split(line, "|")
			if len(parts) == 2 {
				diskUsed, _ = strconv.ParseInt(parts[0], 10, 64)
				diskTotal, _ = strconv.ParseInt(parts[1], 10, 64)
			}
			continue
		}
		parts := strings.Split(line, "|")
		if len(parts) != 4 {
			continue
		}
		metric := ContainerMetric{InstanceID: parts[0]}
		metric.CPUPercent, _ = strconv.ParseFloat(strings.TrimSuffix(parts[1], "%"), 64)
		metric.MemoryBytes = parseDockerSize(strings.Split(parts[2], "/")[0])
		metric.MemoryPercent, _ = strconv.ParseFloat(strings.TrimSuffix(parts[3], "%"), 64)
		metrics = append(metrics, metric)
	}
	return metrics, diskUsed, diskTotal, nil
}

func (d *Docker) InstanceState(ctx context.Context, host domain.Host, instance domain.Instance) (string, string, error) {
	result, err := d.runner.Run(ctx, host, composeCommand(instance)+` ps --format json`, nil)
	if err != nil {
		return "unknown", "", err
	}
	type row struct {
		State    string `json:"State"`
		Health   string `json:"Health"`
		ExitCode int    `json:"ExitCode"`
	}
	var rows []row
	text := strings.TrimSpace(result.Stdout)
	if strings.HasPrefix(text, "[") {
		_ = json.Unmarshal([]byte(text), &rows)
	} else {
		for _, line := range strings.Split(text, "\n") {
			var item row
			if json.Unmarshal([]byte(line), &item) == nil {
				rows = append(rows, item)
			}
		}
	}
	if len(rows) == 0 {
		return "stopped", "", nil
	}
	allRunning := true
	health := ""
	for _, item := range rows {
		if strings.ToLower(item.State) != "running" {
			allRunning = false
		}
		if item.Health != "" && strings.ToLower(item.Health) != "healthy" {
			health = item.Health
		}
	}
	if allRunning && health == "" {
		return "running", "healthy", nil
	}
	if allRunning {
		return "degraded", health, nil
	}
	return "stopped", health, nil
}

func (d *Docker) ManagedStates(ctx context.Context, host domain.Host) (map[string]ManagedState, error) {
	command := `containers="$(docker ps -aq --filter label=dbmock.instance)" || exit $?
if [ -n "$containers" ]; then
  docker inspect --format '{{index .Config.Labels "dbmock.instance"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}' $containers
fi`
	result, err := d.runner.Run(ctx, host, command, nil)
	if err != nil {
		return nil, err
	}
	return parseManagedStates(result.Stdout), nil
}

func parseManagedStates(output string) map[string]ManagedState {
	type summary struct {
		total   int
		running int
		health  string
	}
	summaries := make(map[string]summary)
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "|", 3)
		if len(parts) != 3 || parts[0] == "" {
			continue
		}
		item := summaries[parts[0]]
		item.total++
		if strings.EqualFold(parts[1], "running") {
			item.running++
		}
		health := strings.ToLower(strings.TrimSpace(parts[2]))
		if healthRank(health) > healthRank(item.health) {
			item.health = health
		}
		summaries[parts[0]] = item
	}
	states := make(map[string]ManagedState, len(summaries))
	for id, item := range summaries {
		state := "degraded"
		if item.running == item.total {
			state = "running"
		} else if item.running == 0 {
			state = "stopped"
		}
		states[id] = ManagedState{State: state, Health: item.health}
	}
	return states
}

func healthRank(health string) int {
	switch health {
	case "":
		return 0
	case "healthy":
		return 1
	case "starting":
		return 2
	default:
		return 3
	}
}

func composeCommand(instance domain.Instance) string {
	return "docker compose --project-name " + ShellQuote(instance.ComposeProject) + " --project-directory " +
		ShellQuote(instance.RemoteDirectory) + " --file " + ShellQuote(path.Join(instance.RemoteDirectory, "compose.yaml"))
}

func proxyPrefix(host domain.Host) string {
	var values []string
	if host.ProxyHTTP != "" {
		values = append(values, "HTTP_PROXY="+ShellQuote(host.ProxyHTTP), "http_proxy="+ShellQuote(host.ProxyHTTP))
	}
	if host.ProxyHTTPS != "" {
		values = append(values, "HTTPS_PROXY="+ShellQuote(host.ProxyHTTPS), "https_proxy="+ShellQuote(host.ProxyHTTPS))
	}
	if host.ProxyNoProxy != "" {
		values = append(values, "NO_PROXY="+ShellQuote(host.ProxyNoProxy), "no_proxy="+ShellQuote(host.ProxyNoProxy))
	}
	if len(values) == 0 {
		return ""
	}
	return strings.Join(values, " ") + " "
}

func validateManagedDirectory(root, directory string) error {
	cleanRoot := path.Clean(root)
	cleanDirectory := path.Clean(directory)
	prefix := path.Join(cleanRoot, "instances") + "/"
	if cleanRoot == "." || cleanRoot == "/" || !strings.HasPrefix(cleanDirectory, prefix) || cleanDirectory == prefix {
		return fmt.Errorf("unsafe managed directory %q outside %q", directory, root)
	}
	return nil
}

func parseDockerSize(value string) int64 {
	value = strings.TrimSpace(value)
	units := []struct {
		suffix     string
		multiplier float64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1}}
	for _, unit := range units {
		if strings.HasSuffix(value, unit.suffix) {
			number, _ := strconv.ParseFloat(strings.TrimSpace(strings.TrimSuffix(value, unit.suffix)), 64)
			return int64(number * unit.multiplier)
		}
	}
	return 0
}
