package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	appcrypto "github.com/pika/db-mock/internal/crypto"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/store"
)

const CookieName = "dbmock_session"

type contextKey struct{}

type Actor struct {
	User      domain.User
	SessionID uuid.UUID
	IP        string
	RequestID string
}

type Service struct {
	store           *store.Store
	sessionDuration time.Duration
	secureCookie    bool
}

func New(target *store.Store, duration time.Duration, secureCookie bool) *Service {
	return &Service{store: target, sessionDuration: duration, secureCookie: secureCookie}
}

func (s *Service) Setup(ctx context.Context, username, displayName, password, locale, ip, userAgent string) (domain.User, string, error) {
	hash, err := appcrypto.HashPassword(password)
	if err != nil {
		return domain.User{}, "", domain.ErrInvalid
	}
	user, err := s.store.CreateInitialUser(ctx, username, displayName, locale, hash)
	if err != nil {
		return domain.User{}, "", err
	}
	token, _, err := s.store.CreateSession(ctx, user.ID, s.sessionDuration, ip, userAgent)
	return user, token, err
}

func (s *Service) Login(ctx context.Context, username, password, ip, userAgent string) (domain.User, string, error) {
	user, err := s.store.FindUserByUsername(ctx, username)
	if err != nil || user.DisabledAt != nil || !appcrypto.VerifyPassword(user.PasswordHash, password) {
		return domain.User{}, "", domain.ErrUnauthorized
	}
	token, _, err := s.store.CreateSession(ctx, user.ID, s.sessionDuration, ip, userAgent)
	return user, token, err
}

func (s *Service) Resolve(r *http.Request) (Actor, error) {
	cookie, err := r.Cookie(CookieName)
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return Actor{}, domain.ErrUnauthorized
	}
	user, session, err := s.store.ResolveSession(r.Context(), cookie.Value)
	if err != nil {
		return Actor{}, domain.ErrUnauthorized
	}
	return Actor{User: user, SessionID: session.ID, IP: ClientIP(r), RequestID: RequestID(r.Context())}, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.store.DeleteSession(ctx, token)
}

func (s *Service) ChangePassword(ctx context.Context, user domain.User, sessionID uuid.UUID, currentPassword, newPassword string) error {
	if currentPassword == "" || newPassword == "" {
		return fmt.Errorf("%w: current password and new password are required", domain.ErrInvalid)
	}
	if !appcrypto.VerifyPassword(user.PasswordHash, currentPassword) {
		return fmt.Errorf("%w: current password is incorrect", domain.ErrInvalid)
	}
	if currentPassword == newPassword {
		return fmt.Errorf("%w: new password must be different from current password", domain.ErrInvalid)
	}
	newHash, err := appcrypto.HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("%w: new password is invalid", domain.ErrInvalid)
	}
	return s.store.ChangeOwnPassword(ctx, user.ID, sessionID, user.PasswordHash, newHash)
}

func (s *Service) SetCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: token, Path: "/", HttpOnly: true, Secure: s.secureCookie,
		SameSite: http.SameSiteStrictMode, MaxAge: int(s.sessionDuration.Seconds()), Expires: time.Now().Add(s.sessionDuration)})
}

func (s *Service) ClearCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: "", Path: "/", HttpOnly: true, Secure: s.secureCookie,
		SameSite: http.SameSiteStrictMode, MaxAge: -1, Expires: time.Unix(1, 0)})
}

func (s *Service) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor, err := s.Resolve(r)
		if err != nil {
			writeUnauthorized(w, r)
			return
		}
		next.ServeHTTP(w, r.WithContext(WithActor(r.Context(), actor)))
	})
}

func WithActor(ctx context.Context, actor Actor) context.Context {
	return context.WithValue(ctx, contextKey{}, actor)
}
func ActorFrom(ctx context.Context) (Actor, bool) {
	actor, ok := ctx.Value(contextKey{}).(Actor)
	return actor, ok
}

type requestIDKey struct{}

func WithRequestID(ctx context.Context, value string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, value)
}
func RequestID(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	return value
}

func ClientIP(r *http.Request) string {
	value := r.RemoteAddr
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		value = strings.TrimSpace(strings.Split(forwarded, ",")[0])
	}
	if index := strings.LastIndex(value, ":"); index > 0 && !strings.Contains(value[index+1:], "]") {
		value = strings.Trim(value[:index], "[]")
	}
	return value
}

func writeUnauthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"Authentication required"}}`))
}

var _ = errors.Is
