package hostops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"

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

func NewDocker(runner Runner) *Docker { return &Docker{runner: runner} }

func (d *Docker) Probe(ctx context.Context, host domain.Host) (ProbeResult, error) {
	return d.runner.Probe(ctx, host)
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

func (d *Docker) WriteProject(ctx context.Context, host domain.Host, instance domain.Instance, compose, env []byte, files map[string][]byte) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	if _, err := d.runner.Run(ctx, host, "mkdir -p "+ShellQuote(instance.RemoteDirectory), nil); err != nil {
		return err
	}
	if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, "compose.yaml"), compose, 0o600); err != nil {
		return err
	}
	if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, ".env"), env, 0o600); err != nil {
		return err
	}
	for name, content := range files {
		clean := path.Clean(name)
		if strings.HasPrefix(clean, "../") || path.IsAbs(clean) {
			return fmt.Errorf("unsafe project file %q", name)
		}
		if err := d.runner.WriteFile(ctx, host, path.Join(instance.RemoteDirectory, clean), content, 0o600); err != nil {
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

func (d *Docker) SnapshotForUpgrade(ctx context.Context, host domain.Host, instance domain.Instance) (string, error) {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return "", err
	}
	snapshot := path.Join(instance.RemoteDirectory, "upgrade-snapshot.tar.gz")
	command := composeCommand(instance) + " stop --timeout 120 && tar -C " + ShellQuote(instance.RemoteDirectory) +
		" -czf " + ShellQuote(snapshot) + " --exclude=upgrade-snapshot.tar.gz ."
	_, err := d.runner.Run(ctx, host, command, nil)
	return snapshot, err
}

func (d *Docker) RestoreUpgradeSnapshot(ctx context.Context, host domain.Host, instance domain.Instance, snapshot string) error {
	if err := validateManagedDirectory(host.DataRoot, instance.RemoteDirectory); err != nil {
		return err
	}
	if snapshot != path.Join(instance.RemoteDirectory, "upgrade-snapshot.tar.gz") {
		return errors.New("invalid upgrade snapshot path")
	}
	command := "find " + ShellQuote(instance.RemoteDirectory) + " -mindepth 1 -maxdepth 1 ! -name upgrade-snapshot.tar.gz -exec rm -rf -- {} + && tar -C " +
		ShellQuote(instance.RemoteDirectory) + " -xzf " + ShellQuote(snapshot)
	_, err := d.runner.Run(ctx, host, command, nil)
	return err
}

func (d *Docker) DeleteUpgradeSnapshot(ctx context.Context, host domain.Host, instance domain.Instance) error {
	_, err := d.runner.Run(ctx, host, "rm -f -- "+ShellQuote(path.Join(instance.RemoteDirectory, "upgrade-snapshot.tar.gz")), nil)
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

func (d *Docker) ManagedStates(ctx context.Context, host domain.Host) (map[string]string, error) {
	result, err := d.runner.Run(ctx, host, `docker ps -a --filter label=dbmock.instance --format '{{.Label "dbmock.instance"}}|{{.State}}'`, nil)
	if err != nil {
		return nil, err
	}
	return parseManagedStates(result.Stdout), nil
}

func parseManagedStates(output string) map[string]string {
	states := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), "|", 2)
		if len(parts) != 2 || parts[0] == "" {
			continue
		}
		state := strings.ToLower(parts[1])
		current := states[parts[0]]
		if current == "" {
			states[parts[0]] = state
		} else if current != state {
			states[parts[0]] = "degraded"
		}
	}
	return states
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
