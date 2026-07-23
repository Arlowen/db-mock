package api

import (
	"errors"
	"fmt"
	"testing"

	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/hostops"
)

func TestHostProbeErrorClassifiesUserAndConnectivityFailures(t *testing.T) {
	credential := hostProbeError(fmt.Errorf("wrapped: %w", hostops.ErrSSHCredentialInvalid))
	if !errors.Is(credential, domain.ErrInvalid) {
		t.Fatalf("credential error should be invalid input, got %v", credential)
	}
	if got := credential.Error(); got != "invalid input: SSH credential is invalid" {
		t.Fatalf("credential error = %q", got)
	}

	connectivity := hostProbeError(errors.New("connection refused"))
	if !errors.Is(connectivity, domain.ErrUnavailable) {
		t.Fatalf("connectivity error should be unavailable, got %v", connectivity)
	}
	if got := connectivity.Error(); got != "resource temporarily unavailable: unable to reach the host over SSH" {
		t.Fatalf("connectivity error = %q", got)
	}
}
