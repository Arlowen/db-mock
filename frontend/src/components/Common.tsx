import { Button, Empty, Space, Tag, Typography } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

const colors: Record<string, string> = {
  online: 'green', running: 'green', succeeded: 'green', standard: 'blue',
  pending: 'gold', queued: 'gold', provisioning: 'processing', experimental: 'orange',
  failed: 'red', offline: 'red', critical: 'red', degraded: 'orange', needs_docker: 'purple',
  stopped: 'default', canceled: 'default', custom: 'cyan', warning: 'orange', acknowledged: 'blue', resolved: 'green',
}

export function StatusTag({ value }: { value: string }) {
  const { t } = useTranslation()
  return <Tag color={colors[value] ?? 'default'}>{t(value, { defaultValue: value.replaceAll('_', ' ') })}</Tag>
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return <div className="page-header"><div><Typography.Title level={2}>{title}</Typography.Title>{description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}</div>{actions && <Space wrap>{actions}</Space>}</div>
}

export function EmptyState({ action }: { action?: () => void }) {
  const { t } = useTranslation()
  return <Empty description={t('noData')}>{action && <Button type="primary" onClick={action}>{t('create')}</Button>}</Empty>
}
