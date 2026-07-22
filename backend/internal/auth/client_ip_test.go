package auth

import (
	"net/http/httptest"
	"net/netip"
	"testing"
)

func trustedPrefixes(values ...string) []netip.Prefix {
	result := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		result = append(result, netip.MustParsePrefix(value))
	}
	return result
}

func TestResolveClientIPIgnoresForwardedHeadersFromUntrustedPeers(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "203.0.113.10:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.25")
	if got := ResolveClientIP(request, nil); got != "203.0.113.10" {
		t.Fatalf("ResolveClientIP() = %q, want direct peer", got)
	}
	if got := ClientIP(request); got != "203.0.113.10" {
		t.Fatalf("ClientIP() = %q, want direct peer", got)
	}
}

func TestResolveClientIPWalksTrustedProxyChainFromTheRight(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "10.0.0.2:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.25, 10.0.0.3")
	if got := ResolveClientIP(request, trustedPrefixes("10.0.0.0/8")); got != "198.51.100.25" {
		t.Fatalf("ResolveClientIP() = %q, want original client", got)
	}
}

func TestResolveClientIPStopsAtFirstUntrustedProxyBoundary(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "10.0.0.2:4321"
	request.Header.Set("X-Forwarded-For", "192.0.2.123, 198.51.100.25")
	if got := ResolveClientIP(request, trustedPrefixes("10.0.0.0/8")); got != "198.51.100.25" {
		t.Fatalf("ResolveClientIP() = %q, want first untrusted boundary", got)
	}
}

func TestResolveClientIPSupportsIPv6AndPorts(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "[fd00::2]:4321"
	request.Header.Set("X-Forwarded-For", "[2001:db8::25]:8443, fd00::3")
	if got := ResolveClientIP(request, trustedPrefixes("fd00::/8")); got != "2001:db8::25" {
		t.Fatalf("ResolveClientIP() = %q, want IPv6 client", got)
	}
}

func TestResolveClientIPRejectsMalformedOrOversizedForwardedChains(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "10.0.0.2:4321"
	request.Header.Set("X-Forwarded-For", "198.51.100.25, unknown")
	if got := ResolveClientIP(request, trustedPrefixes("10.0.0.0/8")); got != "10.0.0.2" {
		t.Fatalf("malformed chain resolved to %q", got)
	}

	request.Header.Set("X-Forwarded-For", "198.51.100.1,198.51.100.2,198.51.100.3,198.51.100.4,198.51.100.5,198.51.100.6,198.51.100.7,198.51.100.8,198.51.100.9,198.51.100.10,198.51.100.11,198.51.100.12,198.51.100.13,198.51.100.14,198.51.100.15,198.51.100.16,198.51.100.17,198.51.100.18,198.51.100.19,198.51.100.20,198.51.100.21,198.51.100.22,198.51.100.23,198.51.100.24,198.51.100.25,198.51.100.26,198.51.100.27,198.51.100.28,198.51.100.29,198.51.100.30,198.51.100.31,198.51.100.32,198.51.100.33")
	if got := ResolveClientIP(request, trustedPrefixes("10.0.0.0/8")); got != "10.0.0.2" {
		t.Fatalf("oversized chain resolved to %q", got)
	}
}
