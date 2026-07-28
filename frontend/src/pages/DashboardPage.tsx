import { Alert, Button, Card, Col, List, Row, Segmented, Space, Statistic, Tag, Typography } from 'antd'
import { AlertOutlined, AuditOutlined, CloudServerOutlined, ContainerOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, RightOutlined, SafetyCertificateOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { InstanceCleanupReviewModal } from '../components/InstanceCleanupReview'
import { InstanceLifecycleTag } from '../components/InstanceLifecycle'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { cleanupCandidateCounts, cleanupCandidateMissingContext, filterCleanupCandidates, type CleanupCandidateFilter } from '../lib/cleanup-candidates'
import { dashboardAttentionCanRetry, dashboardAttentionGuidance, dashboardAttentionResourcePath } from '../lib/dashboard-attention'
import { lifecycleCounts } from '../lib/instance-lifecycle'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { taskHostRecoveryPath } from '../lib/task-recovery'
import { useTaskNotification } from '../lib/task-notification'
import type { Dashboard, DashboardAttentionItem, DashboardInstance, Task } from '../lib/types'

function total(values: Record<string, number>) {
  return Object.values(values).reduce((sum, value) => sum + value, 0)
}

export function DashboardPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const navigate = useNavigate()
  const notifyTask = useTaskNotification()
  const [dashboard, setDashboard] = useState<Dashboard>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [attentionActionError, setAttentionActionError] = useState('')
  const [retryingTaskID, setRetryingTaskID] = useState('')
  const [cleanupInstance, setCleanupInstance] = useState<DashboardInstance>()
  const [cleanupFilter, setCleanupFilter] = useState<CleanupCandidateFilter>('all')

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
  const cleanupCounts = useMemo(() => cleanupCandidateCounts(dashboard?.lifecycleInstances || []), [dashboard?.lifecycleInstances])
  const cleanupCandidates = useMemo(
    () => filterCleanupCandidates(dashboard?.lifecycleInstances || [], cleanupFilter),
    [cleanupFilter, dashboard?.lifecycleInstances],
  )
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

  const retryAttention = async (item: DashboardAttentionItem) => {
    if (!item.taskId) return
    try {
      setRetryingTaskID(item.taskId)
      setAttentionActionError('')
      const retried = await api<Task>(`/tasks/${item.taskId}/retry`, { method: 'POST', body: {} })
      notifyTask(retried)
      await load()
    } catch (error) {
      setAttentionActionError(errorMessage(error))
    } finally {
      setRetryingTaskID('')
    }
  }

  return <>
    <PageHeader title={t('workbench')} description={t('workbenchDescription')} />
    {loadError && <Alert className="workbench-alert" type="error" showIcon message={t('workbenchLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => void load()}>{t('retry')}</Button>} />}
    {onboarding && <Alert className="workbench-onboarding" type="info" showIcon message={onboarding.title} description={onboarding.hint} action={canOperate ? <Button type="primary" onClick={() => navigate(onboarding.path)}>{onboarding.action}</Button> : undefined} />}
    <Row className="workbench-stats" gutter={[16, 16]}>
      {cards.map((card) => <Col key={card.path} xs={12} lg={6}><Card loading={loading} className="workbench-stat-card" hoverable role="link" tabIndex={0} onClick={() => navigate(card.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(card.path) }}><div className="workbench-stat-icon">{card.icon}</div><Statistic title={card.title} value={card.value} suffix={card.suffix} /></Card></Col>)}
    </Row>
    <Card
      className="workbench-attention-card"
      loading={loading}
      title={<Space wrap><span>{t('attentionQueue')}</span>{Boolean(dashboard?.attentionItems.length) && <Typography.Text type="danger">{t('attentionCount', { count: dashboard?.attentionItems.length })}</Typography.Text>}</Space>}
      extra={<Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('refresh')}</Button><Button icon={<RightOutlined />} onClick={() => navigate('/tasks')}>{t('viewAllTasks')}</Button></Space>}
    >
      {attentionActionError && <Alert className="workbench-attention-alert" type="error" showIcon message={t('taskActionFailed')} description={attentionActionError} closable onClose={() => setAttentionActionError('')} />}
      {dashboard?.attentionItems.length ? <List
        dataSource={dashboard.attentionItems}
        renderItem={(item) => {
          const guidance = dashboardAttentionGuidance(item)
          const resourcePath = dashboardAttentionResourcePath(item)
          const recoveryHostPath = guidance.inspectHost ? taskHostRecoveryPath(item.hostId, item.taskId) : undefined
          const displayedStatus = item.taskStatus || item.resourceStatus
          return <List.Item className="workbench-attention-item">
            <div className="workbench-attention-content">
              <div className="workbench-attention-summary">
                <Space wrap>
                  {resourcePath
                    ? <Button type="link" className="workbench-instance-link" onClick={() => navigate(resourcePath)}>{item.resourceName}</Button>
                    : <Typography.Text strong>{item.resourceName}</Typography.Text>}
                  <StatusTag value={displayedStatus} />
                  {item.taskKind && <Typography.Text>{translateCode(t, item.taskKind, 'taskKind')}</Typography.Text>}
                </Space>
                <Typography.Text type="secondary">{formatDateTime(item.updatedAt, i18n.language, timezone)}</Typography.Text>
              </div>
              <Typography.Text className="workbench-attention-cause" strong>{t(guidance.causeKey)}</Typography.Text>
              <Typography.Text className="workbench-attention-recovery" type="secondary">{t('attentionNextStep')}: {t(guidance.recoveryKey, { host: item.hostName || t('targetHost') })}</Typography.Text>
              {item.hostName && <Typography.Text className="workbench-attention-host" type="secondary">{t('targetHost')}: {item.hostName}</Typography.Text>}
              <Space className="workbench-attention-actions" wrap>
                {recoveryHostPath && <Button type="primary" icon={<CloudServerOutlined />} onClick={() => navigate(recoveryHostPath)}>{t('inspectFailedHost')}</Button>}
                {item.taskId && <Button onClick={() => navigate(`/tasks?task=${item.taskId}`)}>{t('viewTask')}</Button>}
                {resourcePath && <Button onClick={() => navigate(resourcePath)}>{t('viewResource')}</Button>}
                {canOperate && !recoveryHostPath && dashboardAttentionCanRetry(item) && <Button type="primary" icon={<RedoOutlined />} loading={retryingTaskID === item.taskId} onClick={() => void retryAttention(item)}>{t('retryTask')}</Button>}
              </Space>
            </div>
          </List.Item>
        }}
      /> : !loadError && <EmptyState compact description={t('attentionQueueEmpty')} />}
    </Card>
    <Card
      className="workbench-lifecycle-card"
      loading={loading}
      title={<Space wrap><span>{t('lifecycleQueue')}</span>{dueCounts.expired > 0 && <Typography.Text type="danger">{t('expiredCount', { count: dueCounts.expired })}</Typography.Text>}{dueCounts.dueSoon > 0 && <Typography.Text type="warning">{t('dueSoonCount', { count: dueCounts.dueSoon })}</Typography.Text>}</Space>}
      extra={canOperate ? <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/instances?create=1')}>{t('createInstance')}</Button> : undefined}
    >
      {dashboard?.lifecycleInstances.length ? <>
        <div className="cleanup-candidate-toolbar">
          <div className="cleanup-candidate-intro">
            <Typography.Text strong>{t('cleanupCandidateOverview')}</Typography.Text>
            <Typography.Text type="secondary">{t('cleanupCandidateOverviewHint')}</Typography.Text>
          </div>
          <div className="cleanup-candidate-controls">
            {cleanupCounts.missingContext > 0 && <Typography.Text type="warning">{t('cleanupCandidateMissingContextCount', { count: cleanupCounts.missingContext })}</Typography.Text>}
            <Segmented
              className="cleanup-candidate-filter"
              aria-label={t('cleanupCandidateFilter')}
              value={cleanupFilter}
              onChange={(value) => setCleanupFilter(value as CleanupCandidateFilter)}
              options={[
                { label: t('cleanupCandidateFilterAll', { count: cleanupCounts.all }), value: 'all' },
                { label: t('cleanupCandidateFilterReady', { count: cleanupCounts.ready }), value: 'ready' },
                { label: t('cleanupCandidateFilterBlocked', { count: cleanupCounts.blocked }), value: 'blocked' },
              ]}
            />
          </div>
        </div>
        {cleanupCandidates.length ? <List
          dataSource={cleanupCandidates}
          renderItem={(item) => <List.Item className="workbench-lifecycle-item" actions={[
            ...(canOperate ? [<Button key="cleanup" icon={<SafetyCertificateOutlined />} onClick={() => setCleanupInstance(item)}>{t('reviewCleanup')}</Button>] : []),
            <Button key="details" type="link" onClick={() => navigate(`/instances/${item.id}`)}>{t('details')}</Button>,
          ]}>
            <List.Item.Meta
              title={<Space wrap><Button type="link" className="workbench-instance-link" onClick={() => navigate(`/instances/${item.id}`)}>{item.name}</Button><StatusTag value={item.status} /><InstanceLifecycleTag expiresAt={item.expiresAt} /></Space>}
              description={<>
                <div className="workbench-lifecycle-details"><span>{item.purpose || t('purposeMissing')}</span><span>{item.owner || t('ownerMissing')}</span><span>{item.templateName} {item.templateVersion} · {item.hostName} · {translateCode(t, item.environment)}</span><strong>{formatDateTime(item.expiresAt, i18n.language, timezone)}</strong></div>
                <div className="cleanup-candidate-evidence">
                  <Tag color={item.deleteReady ? 'success' : 'warning'}>{t(item.deleteReady ? 'cleanupCandidateReady' : 'cleanupCandidateBlocked')}</Tag>
                  {cleanupCandidateMissingContext(item) && <Tag color="error">{t('cleanupCandidateMissingContext')}</Tag>}
                  {item.backupCount > 0
                    ? <Button type="link" size="small" className="cleanup-evidence-link" onClick={() => navigate(`/instances/${item.id}?tab=backups&cleanup=review`)}>{t('cleanupCandidateBackupCount', { count: item.backupCount })}</Button>
                    : <Typography.Text type="secondary">{t('cleanupCandidateNoBackups')}</Typography.Text>}
                  {item.activeTask
                    ? <Button type="link" size="small" className="cleanup-evidence-link" onClick={() => navigate(`/tasks?task=${item.activeTask!.id}`)}>{t('cleanupCandidateActiveTask', { task: translateCode(t, item.activeTask.kind, 'taskKind') })}</Button>
                    : <Typography.Text type="secondary">{t('cleanupCandidateNoActiveTask')}</Typography.Text>}
                  {item.blockers.includes('status_not_deletable') && <Typography.Text type="warning">{t('cleanupCandidateStatusBlocked', { status: translateCode(t, item.status) })}</Typography.Text>}
                </div>
              </>}
            />
          </List.Item>}
        /> : <EmptyState compact description={t('cleanupCandidateFilteredEmpty')} />}
      </> : !loadError && <EmptyState compact description={t('lifecycleQueueEmpty')} />}
    </Card>
    {cleanupInstance && <InstanceCleanupReviewModal
      instanceId={cleanupInstance.id}
      instanceName={cleanupInstance.name}
      open
      onClose={() => setCleanupInstance(undefined)}
      onChanged={load}
    />}
  </>
}
