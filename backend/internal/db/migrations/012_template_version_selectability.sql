ALTER TABLE template_versions
    ADD COLUMN IF NOT EXISTS selectable boolean NOT NULL DEFAULT true;

-- The original openGauss 6.0.0 catalog entry pointed at a tag that was never
-- published. Preserve it for historical instances, but prevent new creates and
-- upgrades from selecting it after the corrected immutable version is seeded.
UPDATE template_versions AS version
SET selectable = false
FROM templates AS template
WHERE version.template_id = template.id
  AND template.builtin
  AND template.slug = 'opengauss'
  AND version.version = '6.0.0'
  AND version.image_reference = 'opengauss/opengauss:6.0.0';
