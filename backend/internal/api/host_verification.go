package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
)

const (
	hostVerificationContext = "host-verification:v1"
	hostVerificationTTL     = 10 * time.Minute
)

type hostVerificationReceipt struct {
	HostID             string `json:"hostId,omitempty"`
	InputSHA256        string `json:"inputSha256"`
	HostKey            string `json:"hostKey"`
	PasswordlessSudo   bool   `json:"passwordlessSudo"`
	DataRootWritable   bool   `json:"dataRootWritable"`
	PortProbeAvailable bool   `json:"portProbeAvailable"`
	FirstAvailablePort int    `json:"firstAvailablePort"`
	IssuedAt           int64  `json:"issuedAt"`
	ExpiresAt          int64  `json:"expiresAt"`
}

type verifiedHostInput struct {
	SSHAddress string `json:"sshAddress"`
	SSHPort    int    `json:"sshPort"`
	SSHUser    string `json:"sshUser"`
	AuthType   string `json:"authType"`
	Credential string `json:"credential"`
	Passphrase string `json:"passphrase"`
	DataRoot   string `json:"dataRoot"`
	PortStart  int    `json:"portStart"`
	PortEnd    int    `json:"portEnd"`
}

func hostVerificationDigest(input hostRequest) string {
	value := verifiedHostInput{
		SSHAddress: strings.TrimSpace(input.SSHAddress), SSHPort: input.SSHPort,
		SSHUser: strings.TrimSpace(input.SSHUser), AuthType: input.AuthType,
		Credential: input.Credential, Passphrase: input.Passphrase,
		DataRoot: input.DataRoot, PortStart: input.PortStart, PortEnd: input.PortEnd,
	}
	encoded, _ := json.Marshal(value)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func issueHostVerification(vault *appcrypto.Vault, input hostRequest, hostID *uuid.UUID, probe hostops.ProbeResult, now time.Time) (string, time.Time, error) {
	expiresAt := now.UTC().Add(hostVerificationTTL)
	receipt := hostVerificationReceipt{
		InputSHA256: hostVerificationDigest(input), HostKey: probe.HostKey,
		PasswordlessSudo: probe.PasswordlessSudo, DataRootWritable: probe.DataRootWritable,
		PortProbeAvailable: probe.PortProbeAvailable, FirstAvailablePort: probe.FirstAvailablePort,
		IssuedAt: now.UTC().Unix(), ExpiresAt: expiresAt.Unix(),
	}
	if hostID != nil {
		receipt.HostID = hostID.String()
	}
	encoded, err := json.Marshal(receipt)
	if err != nil {
		return "", time.Time{}, err
	}
	token, err := vault.Seal(encoded, hostVerificationContext)
	return token, expiresAt, err
}

func verifyHostVerification(vault *appcrypto.Vault, token string, input hostRequest, hostID *uuid.UUID, now time.Time) (hostVerificationReceipt, error) {
	if strings.TrimSpace(token) == "" {
		return hostVerificationReceipt{}, fmt.Errorf("%w: test the SSH connection before saving", domain.ErrInvalid)
	}
	plain, err := vault.Open(token, hostVerificationContext)
	if err != nil {
		return hostVerificationReceipt{}, fmt.Errorf("%w: host verification token is invalid", domain.ErrInvalid)
	}
	var receipt hostVerificationReceipt
	if err = json.Unmarshal(plain, &receipt); err != nil {
		return hostVerificationReceipt{}, fmt.Errorf("%w: host verification token is invalid", domain.ErrInvalid)
	}
	expectedHostID := ""
	if hostID != nil {
		expectedHostID = hostID.String()
	}
	actualDigest, digestErr := hex.DecodeString(receipt.InputSHA256)
	expectedDigest, _ := hex.DecodeString(hostVerificationDigest(input))
	validDigest := digestErr == nil && len(actualDigest) == sha256.Size && subtle.ConstantTimeCompare(actualDigest, expectedDigest) == 1
	unixNow := now.UTC().Unix()
	if receipt.HostID != expectedHostID || !validDigest || receipt.HostKey == "" || receipt.IssuedAt > unixNow+60 || receipt.ExpiresAt <= unixNow {
		return hostVerificationReceipt{}, fmt.Errorf("%w: host verification is expired or does not match the submitted connection settings", domain.ErrInvalid)
	}
	if !receipt.DataRootWritable {
		return hostVerificationReceipt{}, fmt.Errorf("%w: %s", domain.ErrUnavailable, hostops.DataRootUnavailableMessage)
	}
	if !receipt.PortProbeAvailable {
		return hostVerificationReceipt{}, fmt.Errorf("%w: %s", domain.ErrUnavailable, hostops.PortProbeUnavailableMessage)
	}
	return receipt, nil
}

func hostVerificationRequired(existing domain.Host, input hostRequest) bool {
	return existing.HostKey == "" || input.Credential != "" ||
		strings.TrimSpace(input.SSHAddress) != existing.SSHAddress || input.SSHPort != existing.SSHPort ||
		strings.TrimSpace(input.SSHUser) != existing.SSHUser || input.AuthType != existing.AuthType ||
		input.DataRoot != existing.DataRoot || input.PortStart != existing.PortStart || input.PortEnd != existing.PortEnd ||
		input.ManageDocker && !existing.ManageDocker
}
