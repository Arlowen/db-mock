import { Button, Empty, Space, Tag, Typography } from 'antd'
import type { ButtonProps } from 'antd'
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

const PageHeaderTargetContext = createContext<HTMLElement | null | undefined>(undefined)

const colors: Record<string, string> = {
  online: 'green', running: 'green', succeeded: 'green', standard: 'blue',
  pending: 'gold', queued: 'gold', retrying: 'gold', sending: 'processing', provisioning: 'processing', starting: 'processing', stopping: 'processing', restarting: 'processing', upgrading: 'processing', reconfiguring: 'processing', backing_up: 'processing', restoring: 'processing', creating: 'processing', ready: 'success', deleting: 'processing', experimental: 'orange',
  failed: 'red', offline: 'red', critical: 'red', degraded: 'orange', needs_docker: 'purple',
  stopped: 'default', canceled: 'default', disabled: 'default', custom: 'cyan', info: 'blue', delivered: 'green', enabled: 'green', warning: 'orange', acknowledged: 'blue', resolved: 'green',
}

export function StatusTag({ value }: { value: string }) {
  const { t } = useTranslation()
  return <Tag color={colors[value] ?? 'default'}>{t(value, { defaultValue: value.replaceAll('_', ' ') })}</Tag>
}

export function PageHeaderTargetProvider({ target, children }: { target: HTMLElement | null; children: ReactNode }) {
  return <PageHeaderTargetContext.Provider value={target}>{children}</PageHeaderTargetContext.Provider>
}

export function PageHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  const target = useContext(PageHeaderTargetContext)
  const copy = <div className="page-header-copy"><Typography.Title level={2} tabIndex={-1}>{title}</Typography.Title>{description && <Typography.Paragraph type="secondary">{description}</Typography.Paragraph>}</div>
  if (target === undefined) return <div className="page-header">{copy}</div>
  return target ? createPortal(<div className="page-header">{copy}</div>, target) : null
}

export function EmptyState({ action, actionIcon, actionLabel, actionType = 'primary', description, compact = false }: { action?: () => void; actionIcon?: ReactNode; actionLabel?: ReactNode; actionType?: ButtonProps['type']; description?: ReactNode; compact?: boolean }) {
  const { t } = useTranslation()
  return <Empty className={compact ? 'compact-empty' : undefined} image={compact ? Empty.PRESENTED_IMAGE_SIMPLE : undefined} description={description ?? t('noData')}>{action && <Button type={actionType} icon={actionIcon} onClick={action}>{actionLabel ?? t('create')}</Button>}</Empty>
}
