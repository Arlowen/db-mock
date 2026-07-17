package store

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/google/uuid"
	"github.com/pika/db-mock/internal/domain"
)

type TemplateInput struct {
	Slug        string
	Name        string
	NameZH      string
	Description string
	Category    string
	Tier        string
	Builtin     bool
	Icon        string
	RiskReport  json.RawMessage
}

type TemplateVersionInput struct {
	Version         string
	ImageReference  string
	Architectures   []string
	MinCPU          float64
	MinMemoryBytes  int64
	MinDiskBytes    int64
	DefaultPort     int
	ComposeTemplate string
	Manifest        json.RawMessage
	PackagePath     string
}

func (s *Store) UpsertTemplate(ctx context.Context, input TemplateInput, version TemplateVersionInput) (domain.Template, error) {
	if len(input.RiskReport) == 0 {
		input.RiskReport = json.RawMessage(`[]`)
	}
	if len(version.Manifest) == 0 {
		version.Manifest = json.RawMessage(`{}`)
	}
	if len(version.Architectures) == 0 {
		version.Architectures = []string{"amd64"}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Template{}, err
	}
	defer tx.Rollback(ctx)
	var item domain.Template
	err = tx.QueryRow(ctx, `INSERT INTO templates(id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(slug) DO UPDATE SET name=excluded.name,name_zh=excluded.name_zh,
        description=excluded.description,category=excluded.category,tier=excluded.tier,
        icon=excluded.icon,risk_report=excluded.risk_report,updated_at=now()
        RETURNING id,slug,name,name_zh,description,category,tier,builtin,icon,risk_report,created_at,updated_at`,
		uuid.New(), input.Slug, input.Name, input.NameZH, input.Description, input.Category, input.Tier,
		input.Builtin, input.Icon, input.RiskReport).Scan(&item.ID, &item.Slug, &item.Name, &item.NameZH,
		&item.Description, &item.Category, &item.Tier, &item.Builtin, &item.Icon, &item.RiskReport,
		&item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return domain.Template{}, err
	}
	var v domain.TemplateVersion
	err = tx.QueryRow(ctx, `INSERT INTO template_versions(id,template_id,version,image_reference,architectures,
        min_cpu,min_memory_bytes,min_disk_bytes,default_port,compose_template,manifest,package_path,immutable)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
        ON CONFLICT(template_id,version) DO UPDATE SET image_reference=excluded.image_reference,
        architectures=excluded.architectures,min_cpu=excluded.min_cpu,min_memory_bytes=excluded.min_memory_bytes,
        min_disk_bytes=excluded.min_disk_bytes,default_port=excluded.default_port,
        compose_template=excluded.compose_template,manifest=excluded.manifest,package_path=excluded.package_path
        RETURNING id,template_id,version,image_reference,architectures,min_cpu,min_memory_bytes,min_disk_bytes,
        default_port,compose_template,manifest,package_path,immutable,created_at`, uuid.New(), item.ID,
		version.Version, version.ImageReference, version.Architectures, version.MinCPU, version.MinMemoryBytes,
		version.MinDiskBytes, version.DefaultPort, version.ComposeTemplate, version.Manifest,
		version.PackagePath).Scan(templateVersionScan(&v)...)
	if err != nil {
		return domain.Template{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Template{}, err
	}
	item.Versions = []domain.TemplateVersion{v}
	return item, nil
}

func templateVersionScan(v *domain.TemplateVersion) []any {
	return []any{&v.ID, &v.TemplateID, &v.Version, &v.ImageReference, &v.Architectures, &v.MinCPU,
		&v.MinMemoryBytes, &v.MinDiskBytes, &v.DefaultPort, &v.ComposeTemplate, &v.Manifest, &v.PackagePath,
		&v.Immutable, &v.CreatedAt}
}

func (s *Store) GetTemplateVersion(ctx context.Context, id uuid.UUID) (domain.Template, domain.TemplateVersion, error) {
	var item domain.Template
	var version domain.TemplateVersion
	scanArgs := []any{&item.ID, &item.Slug, &item.Name, &item.NameZH, &item.Description, &item.Category, &item.Tier,
		&item.Builtin, &item.Icon, &item.RiskReport, &item.CreatedAt, &item.UpdatedAt}
	scanArgs = append(scanArgs, templateVersionScan(&version)...)
	err := s.pool.QueryRow(ctx, `SELECT t.id,t.slug,t.name,t.name_zh,t.description,t.category,t.tier,t.builtin,t.icon,
        t.risk_report,t.created_at,t.updated_at,v.id,v.template_id,v.version,v.image_reference,v.architectures,
        v.min_cpu,v.min_memory_bytes,v.min_disk_bytes,v.default_port,v.compose_template,v.manifest,v.package_path,
        v.immutable,v.created_at FROM template_versions v JOIN templates t ON t.id=v.template_id WHERE v.id=$1`, id).Scan(
		scanArgs...)
	return item, version, translate(err)
}

func (s *Store) ListTemplates(ctx context.Context) ([]domain.Template, error) {
	rows, err := s.pool.Query(ctx, `SELECT t.id,t.slug,t.name,t.name_zh,t.description,t.category,t.tier,t.builtin,t.icon,
        t.risk_report,t.created_at,t.updated_at,v.id,v.template_id,v.version,v.image_reference,v.architectures,
        v.min_cpu,v.min_memory_bytes,v.min_disk_bytes,v.default_port,v.manifest,v.immutable,v.created_at
        FROM templates t LEFT JOIN template_versions v ON v.template_id=t.id
        ORDER BY CASE t.tier WHEN 'standard' THEN 1 WHEN 'experimental' THEN 2 ELSE 3 END,lower(t.name),v.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.Template, 0)
	index := make(map[uuid.UUID]int)
	for rows.Next() {
		var item domain.Template
		var version domain.TemplateVersion
		if err := rows.Scan(&item.ID, &item.Slug, &item.Name, &item.NameZH, &item.Description,
			&item.Category, &item.Tier, &item.Builtin, &item.Icon, &item.RiskReport, &item.CreatedAt,
			&item.UpdatedAt, &version.ID, &version.TemplateID, &version.Version, &version.ImageReference,
			&version.Architectures, &version.MinCPU, &version.MinMemoryBytes, &version.MinDiskBytes,
			&version.DefaultPort, &version.Manifest, &version.Immutable, &version.CreatedAt); err != nil {
			return nil, err
		}
		position, ok := index[item.ID]
		if !ok {
			position = len(items)
			index[item.ID] = position
			item.Versions = make([]domain.TemplateVersion, 0)
			items = append(items, item)
		}
		if version.ID != uuid.Nil {
			items[position].Versions = append(items[position].Versions, version)
		}
	}
	return items, rows.Err()
}

func (s *Store) DeleteTemplate(ctx context.Context, id uuid.UUID) error {
	var builtin bool
	if err := s.pool.QueryRow(ctx, "SELECT builtin FROM templates WHERE id=$1", id).Scan(&builtin); err != nil {
		return translate(err)
	}
	if builtin {
		return domain.ErrForbidden
	}
	var count int
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM instances i JOIN template_versions v ON v.id=i.template_version_id
        WHERE v.template_id=$1 AND i.status<>'deleted'`, id).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return domain.ErrConflict
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "DELETE FROM template_versions WHERE template_id=$1", id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, "DELETE FROM templates WHERE id=$1", id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func NormalizeTemplateSlug(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}
