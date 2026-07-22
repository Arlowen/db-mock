package hostops

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/pika/db-mock/internal/domain"
)

type fakeRemoteFileRenamer struct {
	files          map[string]string
	posixSupported bool
}

func (target *fakeRemoteFileRenamer) PosixRename(oldname, newname string) error {
	if !target.posixSupported {
		return errors.New("posix rename extension is unavailable")
	}
	content, exists := target.files[oldname]
	if !exists {
		return os.ErrNotExist
	}
	delete(target.files, oldname)
	target.files[newname] = content
	return nil
}

func (target *fakeRemoteFileRenamer) Rename(oldname, newname string) error {
	content, exists := target.files[oldname]
	if !exists {
		return os.ErrNotExist
	}
	if _, exists = target.files[newname]; exists {
		return os.ErrExist
	}
	delete(target.files, oldname)
	target.files[newname] = content
	return nil
}

func (target *fakeRemoteFileRenamer) Remove(name string) error {
	if _, exists := target.files[name]; !exists {
		return os.ErrNotExist
	}
	delete(target.files, name)
	return nil
}

func TestReplaceRemoteFileSupportsOpenSSHAndStandardSFTPRename(t *testing.T) {
	for name, posixSupported := range map[string]bool{"OpenSSH extension": true, "portable fallback": false} {
		t.Run(name, func(t *testing.T) {
			remote := &fakeRemoteFileRenamer{posixSupported: posixSupported,
				files: map[string]string{"project.tmp": "new", "project": "old"}}
			if err := replaceRemoteFile(remote, "project.tmp", "project", "project.backup"); err != nil {
				t.Fatal(err)
			}
			if got := remote.files["project"]; got != "new" {
				t.Fatalf("replaced content = %q, want new", got)
			}
			if _, exists := remote.files["project.tmp"]; exists {
				t.Fatal("temporary file remained after replacement")
			}
			if _, exists := remote.files["project.backup"]; exists {
				t.Fatal("backup file remained after replacement")
			}
		})
	}
}

func TestSSHHandshakeErrorClassifiesRejectedCredential(t *testing.T) {
	authentication := sshHandshakeError(errors.New("ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain"))
	if !IsSSHCredentialInvalid(authentication) {
		t.Fatalf("expected authentication rejection to be classified, got %v", authentication)
	}
	network := sshHandshakeError(errors.New("read tcp: connection reset by peer"))
	if IsSSHCredentialInvalid(network) {
		t.Fatalf("network failure must not be classified as an invalid credential: %v", network)
	}
}

func TestShellQuote(t *testing.T) {
	got := ShellQuote("a'b; $(bad)")
	want := `'a'"'"'b; $(bad)'`
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestParseKeyValues(t *testing.T) {
	values := ParseKeyValues("os=Linux\ndisk=10|4\nignored\n")
	if values["os"] != "Linux" || values["disk"] != "10|4" {
		t.Fatalf("unexpected values: %#v", values)
	}
}

func TestParseByteCountAcceptsIntegerAndScientificNotation(t *testing.T) {
	for _, item := range []struct {
		value string
		want  int64
	}{
		{value: "8589934592", want: 8589934592},
		{value: "8.58993e+09", want: 8589930000},
		{value: " 0 ", want: 0},
	} {
		got, ok := parseByteCount(item.value)
		if !ok || got != item.want {
			t.Fatalf("parseByteCount(%q) = %d, %v; want %d, true", item.value, got, ok, item.want)
		}
	}
	for _, value := range []string{"", "unknown", "-1", "NaN", "Inf"} {
		if got, ok := parseByteCount(value); ok {
			t.Fatalf("parseByteCount(%q) = %d, true; want invalid", value, got)
		}
	}
}

func TestProbeResultUsesFrontendJSONContract(t *testing.T) {
	data, err := json.Marshal(ProbeResult{
		HostKey:            "SHA256:example",
		DockerVersion:      "27.5.1",
		PasswordlessSudo:   true,
		DataRootWritable:   true,
		PortProbeAvailable: true,
		FirstAvailablePort: 20001,
	})
	if err != nil {
		t.Fatal(err)
	}
	value := string(data)
	for _, expected := range []string{`"hostKey":"SHA256:example"`, `"dockerVersion":"27.5.1"`, `"passwordlessSudo":true`, `"dataRootWritable":true`, `"portProbeAvailable":true`, `"firstAvailablePort":20001`} {
		if !strings.Contains(value, expected) {
			t.Fatalf("expected %s in %s", expected, value)
		}
	}
	if strings.Contains(value, `"HostKey"`) || strings.Contains(value, `"DockerVersion"`) {
		t.Fatalf("unexpected Go field names in JSON: %s", value)
	}
}

func TestParseProbeResultIncludesManagedStorageAndPortReadiness(t *testing.T) {
	values := ParseKeyValues("os=Linux\narch=x86_64\ndistro=ubuntu:24.04\ndocker=27.5.1\ncompose=2.35.1\n" +
		"passwordless_sudo=true\ncpu=8\nmemory=17179869184\ndisk=107374182400|85899345920\n" +
		"data_root_writable=true\nport_probe_available=true\nfirst_available_port=20042\n")
	probe, err := parseProbeResult(values, "SHA256:example AAAA", 20000, 40000)
	if err != nil {
		t.Fatal(err)
	}
	if !probe.DataRootWritable || !probe.PortProbeAvailable || probe.FirstAvailablePort != 20042 {
		t.Fatalf("unexpected preflight result: %#v", probe)
	}
	values["first_available_port"] = "0"
	probe, err = parseProbeResult(values, "SHA256:example AAAA", 20000, 40000)
	if err != nil || probe.FirstAvailablePort != 0 {
		t.Fatalf("an exhausted but inspectable port pool should be valid: %#v, %v", probe, err)
	}
	values["first_available_port"] = "19999"
	if _, err = parseProbeResult(values, "fingerprint", 20000, 40000); err == nil {
		t.Fatal("port outside the configured pool should be rejected")
	}
}

func TestProbeCommandChecksDataRootAndConfiguredPortPool(t *testing.T) {
	command := probeCommand(domain.Host{DataRoot: "/opt/db mock", PortStart: 21000, PortEnd: 21010})
	for _, expected := range []string{"data_root_writable", "port_probe_available", "first_available_port", "-v start=21000", "-v finish=21010", ShellQuote("/opt/db mock")} {
		if !strings.Contains(command, expected) {
			t.Fatalf("probe command does not contain %q: %s", expected, command)
		}
	}
}
