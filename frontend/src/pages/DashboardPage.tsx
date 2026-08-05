import { Alert, Button, Card, Col, List, Row, Space, Statistic, Typography } from 'antd'
import { AuditOutlined, CloudServerOutlined, CloseCircleOutlined, DatabaseOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { TaskRetryRequestRecovery } from '../components/TaskRetryRequestRecovery'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { dashboardAttentionCanRetry, dashboardAttentionGuidance, dashboardAttentionResourcePath } from '../lib/dashboard-attention'
import { formatDateTime, translateCode } from '../lib/localization'
import { mvpDashboardSummary } from '../lib/mvp-dashboard'
import { permissionsFor } from '../lib/permissions'
import { taskHostRecoveryPath, taskRecoveryResourcePath } from '../lib/task-recovery'
import { useTaskNotification } from '../lib/task-notification'
import { useTaskRetryRequest } from '../lib/use-task-retry-request'
import type { Dashboard, Task } from '../lib/types'

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

  const summary = mvpDashboardSummary(dashboard)
  const onboarding = dashboard && summary.hostCount === 0
    ? { title: t('workbenchNoHostTitle'), hint: t('workbenchNoHostHint'), action: t('addHost'), path: '/hosts?create=1' }
    : dashboard && summary.databaseCount === 0
      ? { title: t('workbenchNoInstanceTitle'), hint: t('workbenchNoInstanceHint'), action: t('createInstance'), path: '/instances?create=1' }
      : undefined

  const cards = [
    { title: t('availableHosts'), value: summary.availableHostCount, suffix: `/ ${summary.hostCount}`, icon: <CloudServerOutlined />, path: '/hosts' },
    { title: t('databases'), value: summary.databaseCount, suffix: <span className={summary.abnormalDatabaseCount ? 'workbench-stat-warning' : 'workbench-stat-ok'}>{t('abnormalDatabasesCount', { count: summary.abnormalDatabaseCount })}</span>, icon: <DatabaseOutlined />, path: '/instances' },
    { title: t('activeTasks'), value: summary.activeTaskCount, icon: <AuditOutlined />, path: '/tasks' },
    { title: t('failedTasks'), value: summary.failedTaskCount, icon: <CloseCircleOutlined />, path: '/tasks' },
  ]

  const retryTask = async (task: Pick<Task, 'id'>) => {
    const retried = await taskRetry.request(task)
    if (retried) notifyTask(retried)
    await load()
  }

  const refreshTaskRetryEvidence = async () => {
    const retried = await taskRetry.refresh()
    if (retried) notifyTask(retried)
    await load()
  }

  return <>
    <PageHeader title={t('workbench')} description={t('workbenchDescription')} />
    <div className="workbench-primary-action">
      {canOperate && <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/instances?create=1')}>{t('createInstance')}</Button>}
    </div>
    {loadError && <Alert className="workbench-alert" type="error" showIcon message={t('workbenchLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => void load()}>{t('retry')}</Button>} />}
    {onboarding && <Alert className="workbench-onboarding" type="info" showIcon message={onboarding.title} description={onboarding.hint} action={canOperate ? <Button type="primary" icon={<CloudServerOutlined />} onClick={() => navigate(onboarding.path)}>{onboarding.action}</Button> : undefined} />}
    <Row className="workbench-stats" gutter={[16, 16]}>
      {cards.map((card) => <Col key={card.title} xs={12} lg={6}><Card loading={loading} className="workbench-stat-card" hoverable role="link" tabIndex={0} onClick={() => navigate(card.path)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(card.path) }}><div className="workbench-stat-icon">{card.icon}</div><Statistic title={card.title} value={card.value} suffix={card.suffix} /></Card></Col>)}
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
  </>
}
