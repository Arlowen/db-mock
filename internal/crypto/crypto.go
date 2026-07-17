package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"

	"golang.org/x/crypto/argon2"
)

const passwordVersion = "v1"

type Vault struct {
	aead cipher.AEAD
}

func NewVault(key []byte) (*Vault, error) {
	if len(key) != 32 {
		return nil, errors.New("vault key must be exactly 32 bytes")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create AES cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	return &Vault{aead: aead}, nil
}

func (v *Vault) Seal(plain []byte, context string) (string, error) {
	nonce := make([]byte, v.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", fmt.Errorf("generate nonce: %w", err)
	}
	ciphertext := v.aead.Seal(nil, nonce, plain, []byte(context))
	sealed := append(nonce, ciphertext...)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (v *Vault) Open(encoded, context string) ([]byte, error) {
	sealed, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, errors.New("invalid encrypted value")
	}
	if len(sealed) < v.aead.NonceSize() {
		return nil, errors.New("encrypted value is too short")
	}
	nonce, ciphertext := sealed[:v.aead.NonceSize()], sealed[v.aead.NonceSize():]
	plain, err := v.aead.Open(nil, nonce, ciphertext, []byte(context))
	if err != nil {
		return nil, errors.New("cannot decrypt value")
	}
	return plain, nil
}

func HashPassword(password string) (string, error) {
	if password == "" {
		return "", errors.New("password cannot be empty")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	hash := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return fmt.Sprintf("%s$argon2id$v=19$m=65536,t=3,p=2$%s$%s", passwordVersion,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(hash)), nil
}

func VerifyPassword(encoded, password string) bool {
	var version, algorithm, params, saltText, hashText string
	if _, err := fmt.Sscanf(encoded, "%2s$%8s$v=19$%14s$%s$%s", &version, &algorithm, &params, &saltText, &hashText); err != nil {
		// Sscanf is deliberately avoided for the actual parsing below; this branch
		// only provides a cheap malformed-input rejection.
	}
	parts := split(encoded, '$')
	if len(parts) != 6 || parts[0] != passwordVersion || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=65536,t=3,p=2" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) != 32 {
		return false
	}
	got := argon2.IDKey([]byte(password), salt, 3, 64*1024, 2, 32)
	return subtle.ConstantTimeCompare(got, want) == 1
}

func SignHMAC(secret, payload []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(payload)
	return "sha256=" + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func split(value string, separator byte) []string {
	parts := make([]string, 0, 8)
	start := 0
	for i := 0; i < len(value); i++ {
		if value[i] == separator {
			parts = append(parts, value[start:i])
			start = i + 1
		}
	}
	return append(parts, value[start:])
}
