package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSessionCookieSecurityFollowsPublicTransport(t *testing.T) {
	for _, test := range []struct {
		name   string
		secure bool
	}{
		{name: "http", secure: false},
		{name: "https", secure: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			service := New(nil, time.Hour, test.secure)
			recorder := httptest.NewRecorder()
			service.SetCookie(recorder, "session-token")
			cookies := recorder.Result().Cookies()
			if len(cookies) != 1 {
				t.Fatalf("cookie count = %d, want 1", len(cookies))
			}
			cookie := cookies[0]
			if cookie.Secure != test.secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
				t.Fatalf("unexpected session cookie: %#v", cookie)
			}
		})
	}
}
