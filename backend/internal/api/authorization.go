package api

import (
	"net/http"

	"github.com/pika/db-mock/internal/auth"
	"github.com/pika/db-mock/internal/domain"
	"github.com/pika/db-mock/internal/httpx"
)

func requireRoles(roles ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(roles))
	for _, role := range roles {
		allowed[role] = struct{}{}
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			actor, ok := auth.ActorFrom(r.Context())
			if !ok {
				httpx.Error(w, r, domain.ErrUnauthorized)
				return
			}
			if _, ok = allowed[actor.User.Role]; !ok {
				httpx.Error(w, r, domain.ErrForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func requireAdmin(next http.Handler) http.Handler {
	return requireRoles(domain.RoleAdmin)(next)
}

func requireOperator(next http.Handler) http.Handler {
	return requireRoles(domain.RoleAdmin, domain.RoleOperator)(next)
}
