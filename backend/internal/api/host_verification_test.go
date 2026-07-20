package api

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
)

func TestHostVerificationBindsConnectionSettingsAndScope(t *testing.T) {
	vault, err := appcrypto.NewVault(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.July, 20, 12, 0, 0, 0, time.UTC)
	hostID := uuid.New()
	input := hostRequest{SSHAddress: "10.0.0.8", SSHPort: 22, SSHUser: "dbmock", AuthType: "private_key",
		Credential: "private-key", Passphrase: "key-secret", DataRoot: "/opt/dbmock", PortStart: 20000, PortEnd: 40000}
	probe := hostops.ProbeResult{HostKey: "SHA256:verified AAAA", PasswordlessSudo: true,
		DataRootWritable: true, PortProbeAvailable: true, FirstAvailablePort: 20001}
	token, expiresAt, err := issueHostVerification(vault, input, &hostID, probe, now)
	if err != nil {
		t.Fatal(err)
	}
	if !expiresAt.Equal(now.Add(hostVerificationTTL)) {
		t.Fatalf("expires at %s", expiresAt)
	}
	receipt, err := verifyHostVerification(vault, token, input, &hostID, now.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if receipt.HostKey != probe.HostKey || receipt.FirstAvailablePort != probe.FirstAvailablePort || !receipt.PasswordlessSudo {
		t.Fatalf("unexpected receipt: %#v", receipt)
	}

	changed := input
	changed.DataRoot = "/srv/dbmock"
	if _, err = verifyHostVerification(vault, token, changed, &hostID, now); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("changed data root should invalidate verification, got %v", err)
	}
	changed = input
	changed.Credential = "different-key"
	if _, err = verifyHostVerification(vault, token, changed, &hostID, now); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("changed credential should invalidate verification, got %v", err)
	}
	otherHostID := uuid.New()
	if _, err = verifyHostVerification(vault, token, input, &otherHostID, now); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("different host scope should invalidate verification, got %v", err)
	}
	if _, err = verifyHostVerification(vault, token, input, &hostID, expiresAt); !errors.Is(err, domain.ErrInvalid) {
		t.Fatalf("expired verification should be rejected, got %v", err)
	}
}

func TestHostVerificationRejectsMissingHostPreflight(t *testing.T) {
	vault, _ := appcrypto.NewVault(make([]byte, 32))
	now := time.Now()
	input := hostRequest{SSHAddress: "host", SSHPort: 22, SSHUser: "user", AuthType: "password",
		Credential: "secret", DataRoot: "/opt/dbmock", PortStart: 20000, PortEnd: 40000}
	probe := hostops.ProbeResult{HostKey: "SHA256:verified", DataRootWritable: false, PortProbeAvailable: true}
	token, _, err := issueHostVerification(vault, input, nil, probe, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = verifyHostVerification(vault, token, input, nil, now); !errors.Is(err, domain.ErrUnavailable) {
		t.Fatalf("unwritable data root should be rejected, got %v", err)
	}
	probe.DataRootWritable, probe.PortProbeAvailable = true, false
	token, _, _ = issueHostVerification(vault, input, nil, probe, now)
	if _, err = verifyHostVerification(vault, token, input, nil, now); !errors.Is(err, domain.ErrUnavailable) {
		t.Fatalf("missing port probe should be rejected, got %v", err)
	}
}

func TestHostVerificationRequiredForOperationalChanges(t *testing.T) {
	existing := domain.Host{HostKey: "SHA256:known", SSHAddress: "host", SSHPort: 22, SSHUser: "user",
		AuthType: "password", DataRoot: "/opt/dbmock", PortStart: 20000, PortEnd: 40000, ManageDocker: false}
	input := hostRequest{SSHAddress: existing.SSHAddress, SSHPort: existing.SSHPort, SSHUser: existing.SSHUser,
		AuthType: existing.AuthType, DataRoot: existing.DataRoot, PortStart: existing.PortStart, PortEnd: existing.PortEnd}
	if hostVerificationRequired(existing, input) {
		t.Fatal("metadata-only update should not require another SSH test")
	}
	for name, mutate := range map[string]func(*hostRequest){
		"address":       func(value *hostRequest) { value.SSHAddress = "other" },
		"root":          func(value *hostRequest) { value.DataRoot = "/srv/dbmock" },
		"pool":          func(value *hostRequest) { value.PortStart++ },
		"credential":    func(value *hostRequest) { value.Credential = "new-secret" },
		"docker policy": func(value *hostRequest) { value.ManageDocker = true },
	} {
		t.Run(name, func(t *testing.T) {
			changed := input
			mutate(&changed)
			if !hostVerificationRequired(existing, changed) {
				t.Fatal("operational change should require SSH verification")
			}
		})
	}
}
