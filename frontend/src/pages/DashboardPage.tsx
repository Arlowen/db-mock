import { Alert, Button, Card, Col, List, Row, Space, Statistic, Typography } from 'antd'
import { AlertOutlined, AuditOutlined, CloudServerOutlined, ContainerOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { InstanceLifecycleTag } from '../components/InstanceLifecycle'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { lifecycleCounts } from '../lib/instance-lifecycle'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import type { Dashboard } from '../lib/types'

function total(values: Record<string, number>) {
  return Object.values(values).reduce((sum, value) => sum + value, 0)
}

export function DashboardPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const navigate = useNavigate()
  const [dashboard, setDashboard] = useState<Dashboard>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setLoadError('')
      setDashboard(await api<Dashboard>('/dashboard'))
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const hostCount = total(dashboard?.hosts || {})
  const instanceCount = total(dashboard?.instances || {})
  const dueCounts = useMemo(() => lifecycleCounts(dashboard?.lifecycleInstances || []), [dashboard?.lifecycleInstances])
  const onboarding = dashboard && hostCount === 0
    ? { title: t('workbenchNoHostTitle'), hint: t('workbenchNoHostHint'), action: t('addHost'), path: '/hosts?create=1' }
    : dashboard && instanceCount === 0
      ? { title: t('workbenchNoInstanceTitle'), hint: t('workbenchNoInstanceHint'), action: t('createInstance'), path: '/instances?create=1' }
      : undefined

  const cards = [
    { title: t('availableHosts'), value: dashboard?.hosts.online || 0, suffix: `/ ${hostCount}`, icon: <CloudServerOutlined />, path: '/hosts' },
    { title: t('runningInstances'), value: dashboard?.instances.running || 0, suffix: `/ ${instanceCount}`, icon: <ContainerOutlined />, path: '/instances' },
    { title: t('activeTasks'), value: dashboard?.activeTasks || 0, icon: <AuditOutlined />, path: '/tasks' },
    { title: t('openAlerts'), value: dashboard?.openAlerts || 0, icon: <AlertOutlined />, path: '/alerts' },
  ]

  return <>
    <PageHeader title={t('workbench')} description={t('workbenchDescription')} />
    {loadError && <Alert className="workbench-alert" type="error" showIcon message={t('workbenchLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => void load()}>{t('retry')}</Button>} />}
    {onboarding && <Alert className="workbench-onboarding" type="info" showIcon message={onboarding.title} description={onboarding.hint} action={canOperate ? <Button type="primary" onClick={() => navigate(onboarding.path)}>{onboarding.action}</Button> : undefined} />}
    <Row className="workbench-stats" gutter={[16, 16]}>
      {cards.map((card) => <Col key={card.path} xs={12} lg={6}><Card loading={loading} className="workbench-stat-card" hoverable role="link" tabIndex={0} onClick={() => navigate(card.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(card.path) }}><div className="workbench-stat-icon">{card.icon}</div><Statistic title={card.title} value={card.value} suffix={card.suffix} /></Card></Col>)}
    </Row>
    <Card
      className="workbench-lifecycle-card"
      loading={loading}
      title={<Space wrap><span>{t('lifecycleQueue')}</span>{dueCounts.expired > 0 && <Typography.Text type="danger">{t('expiredCount', { count: dueCounts.expired })}</Typography.Text>}{dueCounts.dueSoon > 0 && <Typography.Text type="warning">{t('dueSoonCount', { count: dueCounts.dueSoon })}</Typography.Text>}</Space>}
      extra={<Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('refresh')}</Button>{canOperate && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/instances?create=1')}>{t('createInstance')}</Button>}</Space>}
    >
      {dashboard?.lifecycleInstances.length ? <List
        dataSource={dashboard.lifecycleInstances}
        renderItem={(item) => <List.Item className="workbench-lifecycle-item" actions={[<Button key="details" type="link" onClick={() => navigate(`/instances/${item.id}`)}>{t('details')}</Button>]}>
          <List.Item.Meta
            title={<Space wrap><Button type="link" className="workbench-instance-link" onClick={() => navigate(`/instances/${item.id}`)}>{item.name}</Button><StatusTag value={item.status} /><InstanceLifecycleTag expiresAt={item.expiresAt} /></Space>}
            description={<div className="workbench-lifecycle-details"><span>{item.purpose || t('purposeMissing')}</span><span>{item.owner || t('ownerMissing')}</span><span>{item.templateName} {item.templateVersion} · {item.hostName} · {translateCode(t, item.environment)}</span><strong>{formatDateTime(item.expiresAt, i18n.language, timezone)}</strong></div>}
          />
        </List.Item>}
      /> : !loadError && <EmptyState compact description={t('lifecycleQueueEmpty')} />}
    </Card>
  </>
}
