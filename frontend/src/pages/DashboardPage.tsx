import { Alert, Button, Card, Checkbox, Col, List, message, Row, Segmented, Space, Statistic, Tag, Typography } from 'antd'
import { AlertOutlined, AuditOutlined, ClockCircleOutlined, CloudServerOutlined, ContainerOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, RightOutlined, SafetyCertificateOutlined, SaveOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { CleanupBatchDecisionModal } from '../components/CleanupBatchDecisionModal'
import { InstanceCleanupReviewModal } from '../components/InstanceCleanupReview'
import { InstanceLifecycleTag } from '../components/InstanceLifecycle'
import { TaskRetryRequestRecovery } from '../components/TaskRetryRequestRecovery'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { cleanupCandidateCounts, cleanupCandidateMissingContext, filterCleanupCandidates, type CleanupCandidateFilter } from '../lib/cleanup-candidates'
import { cleanupDecisionRejectedMessage, type BatchCleanupDecisionResponse, type CleanupDecision } from '../lib/cleanup-decisions'
import { dashboardAttentionCanRetry, dashboardAttentionGuidance, dashboardAttentionResourcePath } from '../lib/dashboard-attention'
import { lifecycleCounts } from '../lib/instance-lifecycle'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { taskHostRecoveryPath, taskRecoveryResourcePath } from '../lib/task-recovery'
import { useTaskNotification } from '../lib/task-notification'
import { useTaskRetryRequest } from '../lib/use-task-retry-request'
import type { Dashboard, DashboardInstance, Task } from '../lib/types'

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
  const [cleanupInstance, setCleanupInstance] = useState<DashboardInstance>()
  const [cleanupFilter, setCleanupFilter] = useState<CleanupCandidateFilter>('all')
  const [selectedCleanupIDs, setSelectedCleanupIDs] = useState<string[]>([])
  const [cleanupBatchDecision, setCleanupBatchDecision] = useState<CleanupDecision>()
  const [cleanupBatchSubmitting, setCleanupBatchSubmitting] = useState(false)
  const [cleanupBatchRequestError, setCleanupBatchRequestError] = useState('')
  const [cleanupBatchResult, setCleanupBatchResult] = useState<BatchCleanupDecisionResponse>()
  const taskRetry = useTaskRetryRequest()

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
  const selectedCleanupCandidates = useMemo(() => {
    const selected = new Set(selectedCleanupIDs)
    return (dashboard?.lifecycleInstances || []).filter((item) => selected.has(item.id))
  }, [dashboard?.lifecycleInstances, selectedCleanupIDs])
  const visibleCleanupIDs = useMemo(() => cleanupCandidates.map((item) => item.id), [cleanupCandidates])
  const visibleCleanupSelectedCount = useMemo(() => {
    const selected = new Set(selectedCleanupIDs)
    return visibleCleanupIDs.filter((id) => selected.has(id)).length
  }, [selectedCleanupIDs, visibleCleanupIDs])

  useEffect(() => {
    const available = new Set((dashboard?.lifecycleInstances || []).map((item) => item.id))
    setSelectedCleanupIDs((current) => {
      const next = current.filter((id) => available.has(id))
      return next.length === current.length ? current : next
    })
  }, [dashboard?.lifecycleInstances])
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

  const retryTask = async (task: Pick<Task, 'id'>) => {
    const retried = await taskRetry.request(task)
    if (retried) {
      notifyTask(retried)
    }
    await load()
  }

  const refreshTaskRetryEvidence = async () => {
    const retried = await taskRetry.refresh()
    if (retried) notifyTask(retried)
    await load()
  }

  const toggleVisibleCleanupCandidates = (checked: boolean) => {
    setSelectedCleanupIDs((current) => {
      const next = new Set(current)
      visibleCleanupIDs.forEach((id) => checked ? next.add(id) : next.delete(id))
      return Array.from(next)
    })
  }

  const openCleanupBatchDecision = (decision: CleanupDecision) => {
    setCleanupBatchRequestError('')
    setCleanupBatchDecision(decision)
  }

  const submitCleanupBatchDecision = async (
    decision: CleanupDecision,
    instanceIDs: string[],
    closeConfirmation: boolean,
  ) => {
    try {
      setCleanupBatchSubmitting(true)
      setCleanupBatchRequestError('')
      const result = await api<BatchCleanupDecisionResponse>('/instances/batch-cleanup-decisions', {
        method: 'POST',
        body: { instanceIds: instanceIDs, decision, days: decision === 'extend' ? 7 : 0 },
      })
      setCleanupBatchResult((current) => {
        if (closeConfirmation || !current || current.decision !== decision) return result
        const retried = new Set(instanceIDs)
        return {
          ...result,
          updated: [...current.updated.filter((item) => !retried.has(item.instanceId)), ...result.updated],
          rejected: [...current.rejected.filter((item) => !retried.has(item.instanceId)), ...result.rejected],
        }
      })
      setSelectedCleanupIDs(result.rejected.map((item) => item.instanceId))
      if (closeConfirmation) setCleanupBatchDecision(undefined)
      await load()
    } catch (error) {
      if (closeConfirmation) setCleanupBatchRequestError(errorMessage(error))
      else message.error(errorMessage(error))
    } finally {
      setCleanupBatchSubmitting(false)
    }
  }

  const cleanupBatchResultAlert = cleanupBatchResult && <Alert
    className="cleanup-batch-result"
    type={cleanupBatchResult.rejected.length ? cleanupBatchResult.updated.length ? 'warning' : 'error' : 'success'}
    showIcon
    message={cleanupBatchResult.rejected.length
      ? t('batchCleanupPartialResultTitle', { updated: cleanupBatchResult.updated.length, failed: cleanupBatchResult.rejected.length })
      : t('batchCleanupSuccessTitle', { count: cleanupBatchResult.updated.length })}
    description={<div className="cleanup-batch-result-details">
      {cleanupBatchResult.updated.length > 0 && <Typography.Text>{t(cleanupBatchResult.decision === 'extend' ? 'batchCleanupExtendedSummary' : 'batchCleanupRetainedSummary', { count: cleanupBatchResult.updated.length })}</Typography.Text>}
      {cleanupBatchResult.rejected.length > 0 && <ul>{cleanupBatchResult.rejected.map((item) => <li key={item.instanceId}><strong>{item.instanceName || item.instanceId.slice(0, 8)}</strong>: {cleanupDecisionRejectedMessage(item)}</li>)}</ul>}
    </div>}
    action={<Space wrap>
      {cleanupBatchResult.rejected.length > 0 && <Button size="small" icon={<ReloadOutlined />} loading={cleanupBatchSubmitting} onClick={() => void submitCleanupBatchDecision(cleanupBatchResult.decision, cleanupBatchResult.rejected.map((item) => item.instanceId), false)}>{t('retryBatchCleanupFailed', { count: cleanupBatchResult.rejected.length })}</Button>}
      <Button size="small" type="text" onClick={() => setCleanupBatchResult(undefined)}>{t('dismiss')}</Button>
    </Space>}
  />

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
      {taskRetry.failure && taskRetry.evidence && <TaskRetryRequestRecovery
        className="workbench-attention-alert"
        failure={taskRetry.failure}
        evidence={taskRetry.evidence}
        refreshError={taskRetry.refreshError}
        refreshing={taskRetry.refreshing}
        submittingTaskID={taskRetry.submittingTaskID}
        onRetry={(task) => void retryTask(task)}
        onRefresh={() => void refreshTaskRetryEvidence()}
        onOpenTask={(task) => navigate(`/tasks?task=${encodeURIComponent(task.id)}`)}
        onOpenResource={(task) => { const path = taskRecoveryResourcePath(task); if (path) navigate(path) }}
        onClose={taskRetry.clear}
      />}
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
                {canOperate && !recoveryHostPath && dashboardAttentionCanRetry(item) && item.taskId && taskRetry.failure?.taskId !== item.taskId && <Button type="primary" icon={<RedoOutlined />} loading={taskRetry.submittingTaskID === item.taskId} disabled={Boolean(taskRetry.submittingTaskID && taskRetry.submittingTaskID !== item.taskId)} onClick={() => void retryTask({ id: item.taskId! })}>{t('retryTask')}</Button>}
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
      {cleanupBatchResultAlert}
      {dashboard?.lifecycleInstances.length ? <>
        <div className="cleanup-candidate-toolbar">
          <div className="cleanup-candidate-intro">
            <Typography.Text strong>{t('cleanupCandidateOverview')}</Typography.Text>
            <Typography.Text type="secondary">{t('cleanupCandidateOverviewHint')}</Typography.Text>
          </div>
          <div className="cleanup-candidate-controls">
            {cleanupCounts.missingContext > 0 && <Typography.Text type="warning">{t('cleanupCandidateMissingContextCount', { count: cleanupCounts.missingContext })}</Typography.Text>}
            {canOperate && <Checkbox
              checked={visibleCleanupIDs.length > 0 && visibleCleanupSelectedCount === visibleCleanupIDs.length}
              indeterminate={visibleCleanupSelectedCount > 0 && visibleCleanupSelectedCount < visibleCleanupIDs.length}
              disabled={cleanupBatchSubmitting || visibleCleanupIDs.length === 0}
              onChange={(event) => toggleVisibleCleanupCandidates(event.target.checked)}
            >{t('selectVisibleCleanupCandidates', { count: visibleCleanupIDs.length })}</Checkbox>}
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
        {canOperate && selectedCleanupCandidates.length > 0 && <div className="cleanup-batch-toolbar">
          <div className="cleanup-batch-toolbar-copy">
            <Typography.Text strong>{t('batchCleanupSelectionCount', { count: selectedCleanupCandidates.length })}</Typography.Text>
            <Typography.Text type="secondary">{t('batchCleanupSelectionHint')}</Typography.Text>
          </div>
          <Space wrap className="cleanup-batch-toolbar-actions">
            <Button type="primary" icon={<ClockCircleOutlined />} disabled={cleanupBatchSubmitting} onClick={() => openCleanupBatchDecision('extend')}>{t('batchCleanupExtendCount', { count: selectedCleanupCandidates.length })}</Button>
            <Button icon={<SaveOutlined />} disabled={cleanupBatchSubmitting} onClick={() => openCleanupBatchDecision('retain')}>{t('batchCleanupRetainCount', { count: selectedCleanupCandidates.length })}</Button>
            <Button disabled={cleanupBatchSubmitting} onClick={() => setSelectedCleanupIDs([])}>{t('clearSelection')}</Button>
          </Space>
        </div>}
        {cleanupCandidates.length ? <List
          dataSource={cleanupCandidates}
          renderItem={(item) => <List.Item className={`workbench-lifecycle-item${selectedCleanupIDs.includes(item.id) ? ' is-selected' : ''}`} actions={[
            ...(canOperate ? [<Button key="cleanup" icon={<SafetyCertificateOutlined />} onClick={() => setCleanupInstance(item)}>{t('reviewCleanup')}</Button>] : []),
            <Button key="details" type="link" onClick={() => navigate(`/instances/${item.id}`)}>{t('details')}</Button>,
          ]}>
            <div className="cleanup-candidate-main">
              {canOperate && <Checkbox
                className="cleanup-candidate-checkbox"
                aria-label={t('selectCleanupCandidate', { name: item.name })}
                checked={selectedCleanupIDs.includes(item.id)}
                disabled={cleanupBatchSubmitting}
                onChange={(event) => setSelectedCleanupIDs((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))}
              />}
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
            </div>
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
    <CleanupBatchDecisionModal
      decision={cleanupBatchDecision}
      items={selectedCleanupCandidates}
      submitting={cleanupBatchSubmitting}
      requestError={cleanupBatchRequestError}
      timezone={timezone}
      onCancel={() => {
        if (!cleanupBatchSubmitting) {
          setCleanupBatchDecision(undefined)
          setCleanupBatchRequestError('')
        }
      }}
      onSubmit={() => cleanupBatchDecision && void submitCleanupBatchDecision(cleanupBatchDecision, selectedCleanupCandidates.map((item) => item.id), true)}
    />
  </>
}
