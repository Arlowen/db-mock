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
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

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
	HostKey          string  `json:"hostKey"`
	OS               string  `json:"os"`
	Distro           string  `json:"distro"`
	Architecture     string  `json:"architecture"`
	DockerVersion    string  `json:"dockerVersion"`
	ComposeVersion   string  `json:"composeVersion"`
	PasswordlessSudo bool    `json:"passwordlessSudo"`
	CPUCount         float64 `json:"cpuCount"`
	MemoryBytes      int64   `json:"memoryBytes"`
	DiskTotalBytes   int64   `json:"diskTotalBytes"`
	DiskFreeBytes    int64   `json:"diskFreeBytes"`
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
			return nil, fmt.Errorf("parse SSH private key: %w", parseErr)
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
		return nil, fmt.Errorf("SSH handshake: %w", err)
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
	root := ShellQuote(host.DataRoot)
	command := `set -u
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
  else cpu="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)"; memory="$(awk '/MemTotal/{print $2*1024}' /proc/meminfo 2>/dev/null || echo 0)"; fi
fi
root=` + root + `
probe="$root"; while [ ! -e "$probe" ] && [ "$probe" != / ] && [ "$probe" != . ]; do probe="$(dirname "$probe")"; done
disk="$(df -Pk "$probe" 2>/dev/null | awk 'NR==2{print $2*1024 "|" $4*1024}' || true)"
printf 'os=%s\narch=%s\ndistro=%s\ndocker=%s\ncompose=%s\npasswordless_sudo=%s\ncpu=%s\nmemory=%s\ndisk=%s\n' "$os" "$arch" "$distro" "$docker_version" "$compose_version" "$passwordless_sudo" "$cpu" "$memory" "$disk"`
	session, err := client.NewSession()
	if err != nil {
		return ProbeResult{}, err
	}
	defer session.Close()
	output, err := session.CombinedOutput(command)
	if err != nil {
		return ProbeResult{}, fmt.Errorf("probe host: %w: %s", err, output)
	}
	values := ParseKeyValues(string(output))
	result := ProbeResult{
		HostKey:          captured,
		OS:               normalizeOS(values["os"]),
		Distro:           values["distro"],
		Architecture:     normalizeArchitecture(values["arch"]),
		DockerVersion:    values["docker"],
		ComposeVersion:   values["compose"],
		PasswordlessSudo: values["passwordless_sudo"] == "true",
	}
	result.CPUCount, _ = strconv.ParseFloat(values["cpu"], 64)
	result.MemoryBytes, _ = strconv.ParseInt(values["memory"], 10, 64)
	disk := strings.Split(values["disk"], "|")
	if len(disk) == 2 {
		result.DiskTotalBytes, _ = strconv.ParseInt(disk[0], 10, 64)
		result.DiskFreeBytes, _ = strconv.ParseInt(disk[1], 10, 64)
	}
	return result, nil
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
	temporary := path + ".dbmock-tmp"
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
	if err := sftpClient.Rename(temporary, path); err != nil {
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
