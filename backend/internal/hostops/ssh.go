package hostops

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

type Runner interface {
	Probe(ctx context.Context, host domain.Host) (ProbeResult, error)
	Run(ctx context.Context, host domain.Host, command string, stdin io.Reader) (CommandResult, error)
	WriteFile(ctx context.Context, host domain.Host, path string, data []byte, mode os.FileMode) error
	UploadFile(ctx context.Context, host domain.Host, localPath, remotePath string, progress func(int64, int64)) error
}

var ErrSSHCredentialInvalid = errors.New("SSH credential is invalid")

func IsSSHCredentialInvalid(err error) bool {
	return errors.Is(err, ErrSSHCredentialInvalid)
}

func sshHandshakeError(err error) error {
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "unable to authenticate") || strings.Contains(message, "no supported methods remain") {
		return fmt.Errorf("%w: the server rejected the configured password or private key", ErrSSHCredentialInvalid)
	}
	return fmt.Errorf("SSH handshake: %w", err)
}

type Manager struct {
	vault       *crypto.Vault
	dialTimeout time.Duration
}

type CommandResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

type ProbeResult struct {
	HostKey            string  `json:"hostKey"`
	OS                 string  `json:"os"`
	Distro             string  `json:"distro"`
	Architecture       string  `json:"architecture"`
	DockerVersion      string  `json:"dockerVersion"`
	ComposeVersion     string  `json:"composeVersion"`
	PasswordlessSudo   bool    `json:"passwordlessSudo"`
	CPUCount           float64 `json:"cpuCount"`
	MemoryBytes        int64   `json:"memoryBytes"`
	DiskTotalBytes     int64   `json:"diskTotalBytes"`
	DiskFreeBytes      int64   `json:"diskFreeBytes"`
	DataRootWritable   bool    `json:"dataRootWritable"`
	PortProbeAvailable bool    `json:"portProbeAvailable"`
	FirstAvailablePort int     `json:"firstAvailablePort"`
}

func NewManager(vault *crypto.Vault) *Manager {
	return &Manager{vault: vault, dialTimeout: 15 * time.Second}
}

func (m *Manager) credential(host domain.Host) ([]byte, error) {
	return m.vault.Open(host.EncryptedCredential, "host:"+host.ID.String())
}

func (m *Manager) client(ctx context.Context, host domain.Host, captureKey *string) (*ssh.Client, error) {
	credential, err := m.credential(host)
	if err != nil {
		return nil, fmt.Errorf("decrypt SSH credential: %w", err)
	}
	var auth ssh.AuthMethod
	var envelope struct {
		Secret     string `json:"secret"`
		Passphrase string `json:"passphrase"`
	}
	if json.Unmarshal(credential, &envelope) != nil || envelope.Secret == "" {
		envelope.Secret = string(credential)
	}
	switch host.AuthType {
	case "password":
		auth = ssh.Password(envelope.Secret)
	case "private_key":
		var signer ssh.Signer
		var parseErr error
		if envelope.Passphrase != "" {
			signer, parseErr = ssh.ParsePrivateKeyWithPassphrase([]byte(envelope.Secret), []byte(envelope.Passphrase))
		} else {
			signer, parseErr = ssh.ParsePrivateKey([]byte(envelope.Secret))
		}
		if parseErr != nil {
			return nil, fmt.Errorf("%w: parse private key: %v", ErrSSHCredentialInvalid, parseErr)
		}
		auth = ssh.PublicKeys(signer)
	default:
		return nil, fmt.Errorf("unsupported SSH auth type %q", host.AuthType)
	}
	callback := func(_ string, _ net.Addr, key ssh.PublicKey) error {
		fingerprint := ssh.FingerprintSHA256(key)
		if captureKey != nil {
			*captureKey = fingerprint + " " + base64.StdEncoding.EncodeToString(key.Marshal())
		}
		if host.HostKey == "" {
			return nil // Trust on first use; the API surfaces this fingerprint before persistence.
		}
		storedFingerprint := strings.Fields(host.HostKey)[0]
		if storedFingerprint != fingerprint {
			return fmt.Errorf("SSH host key changed: expected %s, received %s", storedFingerprint, fingerprint)
		}
		return nil
	}
	config := &ssh.ClientConfig{
		User:            host.SSHUser,
		Auth:            []ssh.AuthMethod{auth},
		HostKeyCallback: callback,
		Timeout:         m.dialTimeout,
	}
	address := net.JoinHostPort(host.SSHAddress, strconv.Itoa(host.SSHPort))
	dialer := net.Dialer{Timeout: m.dialTimeout, KeepAlive: 30 * time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, fmt.Errorf("dial SSH %s: %w", address, err)
	}
	clientConn, channels, requests, err := ssh.NewClientConn(connection, address, config)
	if err != nil {
		_ = connection.Close()
		return nil, sshHandshakeError(err)
	}
	return ssh.NewClient(clientConn, channels, requests), nil
}

func (m *Manager) Run(ctx context.Context, host domain.Host, command string, stdin io.Reader) (CommandResult, error) {
	client, err := m.client(ctx, host, nil)
	if err != nil {
		return CommandResult{ExitCode: -1}, err
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		return CommandResult{ExitCode: -1}, fmt.Errorf("create SSH session: %w", err)
	}
	defer session.Close()
	var stdout, stderr bytes.Buffer
	session.Stdout = &stdout
	session.Stderr = &stderr
	session.Stdin = stdin
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case <-ctx.Done():
		_ = session.Signal(ssh.SIGTERM)
		_ = session.Close()
		return CommandResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: -1}, ctx.Err()
	case runErr := <-done:
		result := CommandResult{Stdout: stdout.String(), Stderr: stderr.String(), ExitCode: 0}
		if runErr != nil {
			var exitErr *ssh.ExitError
			if errors.As(runErr, &exitErr) {
				result.ExitCode = exitErr.ExitStatus()
			} else {
				result.ExitCode = -1
			}
			return result, fmt.Errorf("remote command failed (exit %d): %s", result.ExitCode, strings.TrimSpace(result.Stderr))
		}
		return result, nil
	}
}

func (m *Manager) Probe(ctx context.Context, host domain.Host) (ProbeResult, error) {
	var captured string
	client, err := m.client(ctx, host, &captured)
	if err != nil {
		return ProbeResult{}, err
	}
	defer client.Close()
	command := probeCommand(host)
	session, err := client.NewSession()
	if err != nil {
		return ProbeResult{}, err
	}
	defer session.Close()
	output, err := session.CombinedOutput(command)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("probe host: %w: %s", err, output)
	}
	return parseProbeResult(ParseKeyValues(string(output)), captured, host.PortStart, host.PortEnd)
}

func probeCommand(host domain.Host) string {
	root := ShellQuote(host.DataRoot)
	portStart := strconv.Itoa(host.PortStart)
	portEnd := strconv.Itoa(host.PortEnd)
	return `set -u
os="$(uname -s 2>/dev/null || true)"
arch="$(uname -m 2>/dev/null || true)"
distro=""
if [ -r /etc/os-release ]; then . /etc/os-release; distro="${ID:-unknown}:${VERSION_ID:-unknown}"; fi
docker_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
compose_version="$(docker compose version --short 2>/dev/null || true)"
passwordless_sudo=false
if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then passwordless_sudo=true; fi
docker_resources="$(docker info --format '{{.NCPU}}|{{.MemTotal}}' 2>/dev/null || true)"
cpu="${docker_resources%%|*}"; memory="${docker_resources#*|}"
if [ -z "$docker_resources" ] || [ "$docker_resources" = "$memory" ]; then
  if [ "$os" = Darwin ]; then cpu="$(sysctl -n hw.ncpu 2>/dev/null || echo 0)"; memory="$(sysctl -n hw.memsize 2>/dev/null || echo 0)";
  else cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"; memory="$(awk '/MemTotal/{printf "%.0f", $2*1024}' /proc/meminfo 2>/dev/null || echo 0)"; fi
fi
root=` + root + `
data_root_writable=false
if [ ! -L "$root" ] && mkdir -p "$root" 2>/dev/null; then
  probe_file="$root/.dbmock-write-probe-$$"
  if (umask 077; set -C; : > "$probe_file") 2>/dev/null; then
    data_root_writable=true
    rm -f -- "$probe_file"
  fi
fi
probe="$root"; while [ ! -e "$probe" ] && [ "$probe" != / ] && [ "$probe" != . ]; do probe="$(dirname "$probe")"; done
disk="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2{printf "%.0f|%.0f", $2*1024, $4*1024}' || true)"
port_probe_available=false
listeners=""
if command -v ss >/dev/null 2>&1; then
  port_probe_available=true; listeners="$(ss -H -ltn 2>/dev/null | awk '{print $4}')"
elif command -v lsof >/dev/null 2>&1; then
  port_probe_available=true; listeners="$(lsof -nP -a -iTCP -sTCP:LISTEN -F n 2>/dev/null | sed -n 's/^n//p')"
elif command -v netstat >/dev/null 2>&1; then
  port_probe_available=true; listeners="$(netstat -an 2>/dev/null | awk '/LISTEN/{print $4}')"
fi
first_available_port=0
if [ "$port_probe_available" = true ]; then
  first_available_port="$(printf '%s\n' "$listeners" | awk -v start=` + portStart + ` -v finish=` + portEnd + ` '
    { value=$1; sub(/^n/, "", value); sub(/^.*[:.]/, "", value); if (value ~ /^[0-9]+$/) used[value]=1 }
    END { for (port=start; port<=finish; port++) if (!used[port]) { print port; exit } }
  ')"
  [ -n "$first_available_port" ] || first_available_port=0
fi
printf 'os=%s\narch=%s\ndistro=%s\ndocker=%s\ncompose=%s\npasswordless_sudo=%s\ncpu=%s\nmemory=%s\ndisk=%s\ndata_root_writable=%s\nport_probe_available=%s\nfirst_available_port=%s\n' "$os" "$arch" "$distro" "$docker_version" "$compose_version" "$passwordless_sudo" "$cpu" "$memory" "$disk" "$data_root_writable" "$port_probe_available" "$first_available_port"`
}

func parseProbeResult(values map[string]string, captured string, portStart, portEnd int) (ProbeResult, error) {
	result := ProbeResult{
		HostKey:            captured,
		OS:                 normalizeOS(values["os"]),
		Distro:             values["distro"],
		Architecture:       normalizeArchitecture(values["arch"]),
		DockerVersion:      values["docker"],
		ComposeVersion:     values["compose"],
		PasswordlessSudo:   values["passwordless_sudo"] == "true",
		DataRootWritable:   values["data_root_writable"] == "true",
		PortProbeAvailable: values["port_probe_available"] == "true",
	}
	var cpuErr error
	var memoryOK, diskTotalOK, diskFreeOK bool
	result.CPUCount, cpuErr = strconv.ParseFloat(values["cpu"], 64)
	result.MemoryBytes, memoryOK = parseByteCount(values["memory"])
	disk := strings.SplitN(values["disk"], "|", 2)
	if len(disk) == 2 {
		result.DiskTotalBytes, diskTotalOK = parseByteCount(disk[0])
		result.DiskFreeBytes, diskFreeOK = parseByteCount(disk[1])
	}
	availablePort, portErr := strconv.Atoi(values["first_available_port"])
	if portErr == nil && (availablePort == 0 || availablePort >= portStart && availablePort <= portEnd) {
		result.FirstAvailablePort = availablePort
	} else {
		portErr = errors.New("invalid available port")
	}
	if cpuErr != nil || result.CPUCount <= 0 || math.IsNaN(result.CPUCount) || math.IsInf(result.CPUCount, 0) || !memoryOK || result.MemoryBytes <= 0 || !diskTotalOK || result.DiskTotalBytes <= 0 || !diskFreeOK || result.DiskFreeBytes < 0 || portErr != nil {
		return ProbeResult{}, fmt.Errorf("%w: unable to determine host CPU, memory, disk, or port-pool capacity", domain.ErrUnavailable)
	}
	return result, nil
}

func parseByteCount(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	if parsed, err := strconv.ParseInt(value, 10, 64); err == nil && parsed >= 0 {
		return parsed, true
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil || parsed < 0 || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed > math.MaxInt64 {
		return 0, false
	}
	return int64(math.Round(parsed)), true
}

type remoteFileRenamer interface {
	PosixRename(oldname, newname string) error
	Rename(oldname, newname string) error
	Remove(name string) error
}

func replaceRemoteFile(client remoteFileRenamer, temporary, target, backup string) error {
	if err := client.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove stale remote file backup: %w", err)
	}
	posixErr := client.PosixRename(temporary, target)
	if posixErr == nil {
		return nil
	}
	if err := client.Rename(temporary, target); err == nil {
		return nil
	}
	if err := client.Rename(target, backup); err != nil {
		return fmt.Errorf("prepare portable remote file replacement after POSIX rename failed (%v): %w", posixErr, err)
	}
	if err := client.Rename(temporary, target); err != nil {
		restoreErr := client.Rename(backup, target)
		if restoreErr != nil {
			return fmt.Errorf("replace remote file: %w; restore previous file: %v", err, restoreErr)
		}
		return fmt.Errorf("replace remote file: %w", err)
	}
	if err := client.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove replaced remote file backup: %w", err)
	}
	return nil
}

func (m *Manager) WriteFile(ctx context.Context, host domain.Host, path string, data []byte, mode os.FileMode) error {
	client, err := m.client(ctx, host, nil)
	if err != nil {
		return err
	}
	defer client.Close()
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return fmt.Errorf("create SFTP client: %w", err)
	}
	defer sftpClient.Close()
	if err := sftpClient.MkdirAll(filepath.ToSlash(filepath.Dir(path))); err != nil {
		return fmt.Errorf("create remote directory: %w", err)
	}
	nonce := uuid.NewString()
	temporary := path + ".dbmock-" + nonce + ".tmp"
	backup := path + ".dbmock-" + nonce + ".backup"
	defer func() {
		_ = sftpClient.Remove(temporary)
		_ = sftpClient.Remove(backup)
	}()
	file, err := sftpClient.OpenFile(temporary, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		return fmt.Errorf("open remote file: %w", err)
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return fmt.Errorf("write remote file: %w", writeErr)
	}
	if closeErr != nil {
		return closeErr
	}
	if err := sftpClient.Chmod(temporary, mode); err != nil {
		return fmt.Errorf("chmod remote file: %w", err)
	}
	if err := replaceRemoteFile(sftpClient, temporary, path, backup); err != nil {
		return fmt.Errorf("rename remote file: %w", err)
	}
	return nil
}

func (m *Manager) UploadFile(ctx context.Context, host domain.Host, localPath, remotePath string, progress func(int64, int64)) error {
	client, err := m.client(ctx, host, nil)
	if err != nil {
		return err
	}
	defer client.Close()
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return err
	}
	defer sftpClient.Close()
	local, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer local.Close()
	stat, err := local.Stat()
	if err != nil {
		return err
	}
	if err := sftpClient.MkdirAll(filepath.ToSlash(filepath.Dir(remotePath))); err != nil {
		return err
	}
	remote, err := sftpClient.OpenFile(remotePath, os.O_CREATE|os.O_WRONLY)
	if err != nil {
		return err
	}
	defer remote.Close()
	var offset int64
	if remoteStat, statErr := remote.Stat(); statErr == nil && remoteStat.Size() < stat.Size() {
		offset = remoteStat.Size()
	} else if statErr == nil && remoteStat.Size() == stat.Size() {
		if progress != nil {
			progress(stat.Size(), stat.Size())
		}
		return nil
	} else {
		if err := remote.Truncate(0); err != nil {
			return err
		}
	}
	if _, err := local.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	if _, err := remote.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	buffer := make([]byte, 1024*1024)
	written := offset
	lastReport := time.Now()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		n, readErr := local.Read(buffer)
		if n > 0 {
			if _, err := remote.Write(buffer[:n]); err != nil {
				return err
			}
			written += int64(n)
			if progress != nil && (time.Since(lastReport) > time.Second || written == stat.Size()) {
				progress(written, stat.Size())
				lastReport = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	return nil
}

func ParseKeyValues(output string) map[string]string {
	values := make(map[string]string)
	for _, line := range strings.Split(output, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return values
}

func normalizeOS(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "linux":
		return "linux"
	case "darwin":
		return "darwin"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func normalizeArchitecture(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "x86_64", "x64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	default:
		return strings.ToLower(strings.TrimSpace(value))
	}
}

func ShellQuote(value string) string {
	if value == "" {
		return "''"
	}
	return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'"
}

func SHA256Fingerprint(data []byte) string {
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

var _ Runner = (*Manager)(nil)
