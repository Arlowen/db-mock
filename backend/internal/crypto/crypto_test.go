package crypto

import (
	"bytes"
	"testing"
)

func TestVaultRoundTripAndContextBinding(t *testing.T) {
	vault, err := NewVault(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := vault.Seal([]byte("secret"), "host:123")
	if err != nil {
		t.Fatal(err)
	}
	plain, err := vault.Open(sealed, "host:123")
	if err != nil || string(plain) != "secret" {
		t.Fatalf("round trip failed: %q, %v", plain, err)
	}
	if _, err := vault.Open(sealed, "host:other"); err == nil {
		t.Fatal("expected context mismatch to fail")
	}
}

func TestPasswordHash(t *testing.T) {
	hash, err := HashPassword("pass")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "pass") {
		t.Fatal("correct password rejected")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("wrong password accepted")
	}
}
