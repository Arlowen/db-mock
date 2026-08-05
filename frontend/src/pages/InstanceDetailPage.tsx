import { CheckCircleOutlined, CloudServerOutlined, CloseCircleOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EyeInvisibleOutlined, LeftOutlined, LockOutlined, PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, Descriptions, Modal, Popconfirm, Progress, Row, Select, Space, Switch, Tabs, Tag, Typography } from 'antd'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import { InstanceDeleteModal } from '../components/InstanceCleanupReview'
import { TaskFailureGuidance } from '../components/TaskFailureGuidance'
import { TaskRetryRequestRecovery } from '../components/TaskRetryRequestRecovery'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import appI18n from '../i18n'
import { ApiError, api, errorMessage } from '../lib/api'
import { connectionHandoffSummary } from '../lib/connection-handoff'
import { canRetryInstanceLifecycleAction, instanceLifecycleRequestRecoveryKey, type InstanceLifecycleAction } from '../lib/instance-operation-recovery'
import { formatDateTime, formatTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { taskFailureGuidance } from '../lib/task-failure'
import { recoveryConfirmationPhase, selectRecoveryConfirmationTask, taskHostRecoveryPath } from '../lib/task-recovery'
import { canCancelTask, canReviewIncompleteDeploymentCleanup, deploymentTaskNextStep, isRecoverableInstanceStatus, isTaskCancellationPending, selectDeploymentHandoff, selectRecoveryTasks } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import { useTaskRetryRequest } from '../lib/use-task-retry-request'
import type { Instance, Task } from '../lib/types'
import { bytes } from '../lib/types'

interface Connection {
  address: string
  port: number
  username: string
  password: string
  database: string
  authentication: 'password' | 'username' | 'none'
  uri: string
  jdbc?: string
}

type TaskInventoryState = 'loading' | 'ready' | 'error'

const detailTabs = new Set(['overview', 'connection', 'logs'])

function responseError(text: string, status: number) {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    return parsed.error?.code
      ? new ApiError(status, parsed.error.code, parsed.error.message || text)
      : new Error(parsed.error?.message || text)
  } catch {
    return new Error(text)
  }
}

function environmentFile(connection: Connection) {
  const value = (input: string) => JSON.stringify(input)
  const lines = [`DB_HOST=${value(connection.address)}`, `DB_PORT=${connection.port}`]
  if (connection.username) lines.push(`DB_USER=${value(connection.username)}`)
  if (connection.authentication === 'password' && connection.password) lines.push(`DB_PASSWORD=${value(connection.password)}`)
  if (connection.database) lines.push(`DB_NAME=${value(connection.database)}`)
  lines.push(`DATABASE_URL=${value(connection.uri)}`)
  return lines.join('\n')
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch { /* fall back when the async clipboard API is unavailable */ }
  const input = document.createElement('textarea')
  input.value = text
  input.style.position = 'fixed'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.select()
  const copied = document.execCommand('copy')
  input.remove()
  if (!copied) throw new Error(appI18n.t('copyFailed'))
}

function connectionHandoffText(
  item: Instance,
  connection: Connection,
  t: TFunction,
) {
  return connectionHandoffSummary({
    instanceName: item.name,
    templateName: item.templateName,
    templateVersion: item.templateVersion,
    status: translateCode(t, item.status),
    ...connection,
    authentication: t(`authenticationMode_${connection.authentication || 'password'}`),
  }, {
    title: t('connectionHandoffTitle'),
    instance: t('connectionHandoffInstance'),
    template: t('template'),
    status: t('status'),
    authentication: t('authentication'),
    dataVersion: t('connectionHandoffDataVersion'),
    backupCreatedAt: t('connectionHandoffBackupTime'),
    restoreVerifiedAt: t('connectionHandoffRestoreVerified'),
    address: t('address'),
    port: t('port'),
    username: t('username'),
    password: t('password'),
    database: t('databaseName'),
    uri: t('uri'),
    jdbc: t('jdbc'),
  })
}

export function InstanceDetailPage() {
  const { id = '' } = useParams()
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { user } = useAuth()
  const { canOperate, canReadCredentials } = permissionsFor(user!)
  const { message } = App.useApp()
  const navigate = useNavigate()
  const notifyTask = useTaskNotification()
  const [detailParams, setDetailParams] = useSearchParams()
  const requestedTab = detailParams.get('tab')
  const requestedRecoveryTaskID = detailParams.get('recoveryTask')?.trim()
  const [item, setItem] = useState<Instance | null>(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskInventoryState, setTaskInventoryState] = useState<TaskInventoryState>('loading')
  const [taskInventoryError, setTaskInventoryError] = useState('')
  const [activeTab, setActiveTab] = useState(detailTabs.has(requestedTab || '') ? requestedTab! : 'overview')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [connectionLoading, setConnectionLoading] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const [logsUpdatedAt, setLogsUpdatedAt] = useState<Date>()
  const [logTail, setLogTail] = useState(1000)
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true)
  const [actioning, setActioning] = useState('')
  const [taskCancellationFailure, setTaskCancellationFailure] = useState<{ taskId: string; message: string }>()
  const [lifecycleConfirmAction, setLifecycleConfirmAction] = useState<InstanceLifecycleAction>()
  const [lifecycleRequestFailure, setLifecycleRequestFailure] = useState<{ action: InstanceLifecycleAction; code: string; message: string }>()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const taskRetry = useTaskRetryRequest()

  const load = useCallback(async () => {
    try {
      const instance = await api<Instance>(`/instances/${id}`)
      setItem(instance)
      setPageError('')
      try {
        const taskResult = await api<{ items: Task[] }>(`/instances/${id}/tasks`)
        setTasks(taskResult.items)
        setTaskInventoryState('ready')
        setTaskInventoryError('')
      } catch (error) {
        const failure = errorMessage(error)
        setTaskInventoryState('error')
        setTaskInventoryError(failure)
        setPageError(failure)
      }
    } catch (error) {
      setPageError(errorMessage(error))
    } finally {
      setPageLoading(false)
    }
  }, [id])

  const instanceTasks = tasks.filter((task) => task.resourceType === 'instance' && task.resourceId === id)
  const activeResourceTask = instanceTasks.find((task) => ['queued', 'running', 'retrying'].includes(task.status))

  useEffect(() => {
    setItem(null)
    setPageLoading(true)
    setPageError('')
    setTasks([])
    setTaskInventoryState('loading')
    setTaskInventoryError('')
    setLifecycleConfirmAction(undefined)
    setLifecycleRequestFailure(undefined)
    setDeleteOpen(false)
    taskRetry.clear()
    void load()
  }, [load, taskRetry.clear])

  useEffect(() => {
    const timer = window.setInterval(() => void load(), activeResourceTask ? 2000 : 10000)
    return () => clearInterval(timer)
  }, [activeResourceTask, load])

  useEffect(() => {
    if (!requestedTab) return
    if (detailTabs.has(requestedTab)) {
      setActiveTab(requestedTab)
      return
    }
    const next = new URLSearchParams(detailParams)
    next.delete('tab')
    next.delete('cleanup')
    setActiveTab('overview')
    setDetailParams(next, { replace: true })
  }, [detailParams, requestedTab, setDetailParams])

  const changeTab = (tab: string) => {
    const next = new URLSearchParams(detailParams)
    if (tab === 'overview') next.delete('tab')
    else next.set('tab', tab)
    next.delete('cleanup')
    setActiveTab(tab)
    setDetailParams(next, { replace: true })
  }

  const finishRecoveryConfirmation = () => {
    const next = new URLSearchParams(detailParams)
    next.delete('recoveryTask')
    setDetailParams(next, { replace: true })
  }

  const runLifecycleAction = async (action: InstanceLifecycleAction) => {
    let accepted = false
    try {
      setActioning(action)
      setLifecycleRequestFailure(undefined)
      const task = await api<Task>(`/instances/${id}/actions/${action}`, { method: 'POST', body: {} })
      setTasks((current) => [task, ...current])
      notifyTask(task)
      await load()
      accepted = true
    } catch (error) {
      setLifecycleRequestFailure({
        action,
        code: error instanceof ApiError ? error.code : 'unknown',
        message: errorMessage(error),
      })
      await load()
    } finally {
      setActioning('')
    }
    return accepted
  }

  const openLifecycleConfirmation = (action: InstanceLifecycleAction) => {
    if (lifecycleRequestFailure?.action !== action) setLifecycleRequestFailure(undefined)
    setLifecycleConfirmAction(action)
  }

  const submitLifecycleAction = async () => {
    if (!lifecycleConfirmAction) return
    if (await runLifecycleAction(lifecycleConfirmAction)) setLifecycleConfirmAction(undefined)
  }

  const refreshLifecycleState = async () => {
    try {
      setActioning('refresh-lifecycle-state')
      await load()
    } finally {
      setActioning('')
    }
  }

  const loadConnection = async () => {
    try {
      setConnectionLoading(true)
      const nextConnection = await api<Connection>(`/instances/${id}/connection`)
      setConnection(nextConnection)
      setConnectionError('')
    } catch (error) {
      setConnectionError(errorMessage(error))
    } finally {
      setConnectionLoading(false)
    }
  }

  const showConnectionHandoff = () => {
    changeTab('connection')
    void loadConnection()
  }

  const loadLogs = useCallback(async () => {
    try {
      setLogsLoading(true)
      setLogsError('')
      const response = await fetch(`/api/v1/instances/${id}/logs?tail=${logTail}`, { credentials: 'same-origin' })
      const text = await response.text()
      if (!response.ok) throw responseError(text, response.status)
      setLogs(text)
      setLogsUpdatedAt(new Date())
    } catch (error) {
      setLogsError(errorMessage(error))
    } finally {
      setLogsLoading(false)
    }
  }, [id, logTail])

  useEffect(() => {
    if (activeTab !== 'logs') return
    void loadLogs()
    if (!logsAutoRefresh) return
    const timer = window.setInterval(() => void loadLogs(), 5000)
    return () => clearInterval(timer)
  }, [activeTab, loadLogs, logsAutoRefresh])

  useEffect(() => {
    if (activeTab !== 'connection') {
      setConnection(null)
      setConnectionError('')
    }
  }, [activeTab])

  const handleDeleteQueued = useCallback((task: Task) => {
    navigate(`/tasks?task=${encodeURIComponent(task.id)}`)
  }, [navigate])
  const handleOpenTask = useCallback((taskId: string) => {
    navigate(`/tasks?task=${encodeURIComponent(taskId)}`)
  }, [navigate])
  const handleInstanceMissing = useCallback(() => {
    navigate('/instances')
  }, [navigate])

  if (!item) return <Card loading={pageLoading}><EmptyState compact action={() => { setPageLoading(true); void load() }} actionIcon={<ReloadOutlined />} actionLabel={t('retry')} actionType="default" description={pageError || t('instanceLoadFailed')} /></Card>

  const { activeTask, failedTask, operationTask } = selectRecoveryTasks(instanceTasks, isRecoverableInstanceStatus(item.status))
  const deploymentHandoff = selectDeploymentHandoff(instanceTasks, item.status)
  const recoveryConfirmationTask = selectRecoveryConfirmationTask(instanceTasks, item.id, requestedRecoveryTaskID)
  const recoveryPhase = recoveryConfirmationPhase(item)
  const failedGuidance = failedTask ? taskFailureGuidance(failedTask) : undefined
  const failedHostRecoveryPath = failedTask && failedGuidance?.inspectHost ? taskHostRecoveryPath(item.hostId, failedTask.id) : undefined
  const lifecycleRequestCanRetry = lifecycleRequestFailure && !operationTask && canRetryInstanceLifecycleAction(lifecycleRequestFailure.action, item.status, lifecycleRequestFailure.code)
  const canStart = item.status === 'stopped' || (item.status === 'failed' && !failedTask && !activeTask)
  const canStopOrRestart = !operationTask && (item.status === 'running' || item.status === 'degraded')
  const lifecycleConfirmationAllowed = lifecycleConfirmAction === 'start'
    ? canStart
    : lifecycleConfirmAction === 'stop' || lifecycleConfirmAction === 'restart'
      ? canStopOrRestart
      : false
  const lifecycleConfirmationCanSubmit = lifecycleConfirmationAllowed && (!lifecycleRequestFailure || lifecycleRequestFailure.action !== lifecycleConfirmAction || lifecycleRequestCanRetry)

  const retryTask = async (task = failedTask) => {
    if (!task) return
    try {
      setActioning('retry-task')
      const retried = await taskRetry.request(task)
      if (retried) {
        setTasks((current) => [retried, ...current])
        notifyTask(retried)
      }
      await load()
    } finally {
      setActioning('')
    }
  }

  const refreshTaskRetryEvidence = async () => {
    const retried = await taskRetry.refresh()
    if (retried) {
      setTasks((current) => [retried, ...current])
      notifyTask(retried)
    }
    await load()
  }

  const cancelOperationTask = async (task: Task) => {
    try {
      setActioning('cancel-task')
      setTaskCancellationFailure(undefined)
      const canceled = await api<Task>(`/tasks/${task.id}/cancel`, { method: 'POST', body: {} })
      setTasks((current) => current.map((candidate) => candidate.id === canceled.id ? canceled : candidate))
      message.success(t(canceled.status === 'canceled' ? 'taskCanceledImmediately' : 'cancelRequested'))
      await load()
    } catch (error) {
      setTaskCancellationFailure({ taskId: task.id, message: errorMessage(error) })
      await load()
    } finally {
      setActioning('')
    }
  }

  const lifecycleRequestFailurePanel = lifecycleRequestFailure && !operationTask && !lifecycleConfirmAction && <Alert
    className="instance-page-alert instance-action-request-alert"
    type="error"
    showIcon
    message={t('instanceActionRequestFailed', { action: t(lifecycleRequestFailure.action) })}
    description={<div className="instance-action-request-description">
      <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{lifecycleRequestFailure.message}</Typography.Text></div>
      <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t('instanceActionRequestImpact')}</Typography.Text></div>
      <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(instanceLifecycleRequestRecoveryKey(lifecycleRequestFailure.code))}</Typography.Text></div>
    </div>}
    action={<Space wrap className="instance-action-request-actions">
      <Button size="small" icon={<ReloadOutlined />} loading={actioning === 'refresh-lifecycle-state'} disabled={!!actioning && actioning !== 'refresh-lifecycle-state'} onClick={() => void refreshLifecycleState()}>{t('refreshStatus')}</Button>
      <Button size="small" onClick={() => changeTab('logs')}>{t('viewInstanceLogs')}</Button>
      {lifecycleRequestCanRetry && <Button size="small" type="primary" disabled={!!actioning} onClick={() => openLifecycleConfirmation(lifecycleRequestFailure.action)}>{t('retryInstanceAction', { action: t(lifecycleRequestFailure.action) })}</Button>}
      <Button size="small" type="text" onClick={() => setLifecycleRequestFailure(undefined)}>{t('dismiss')}</Button>
    </Space>}
  />

  const deploymentNextStep = operationTask ? deploymentTaskNextStep(operationTask) : undefined
  const deploymentCancellationFailure = operationTask && taskCancellationFailure?.taskId === operationTask.id ? taskCancellationFailure : undefined
  const operationPanel = operationTask && <div className={`instance-operation is-${activeTask ? 'active' : 'failed'}`}>
    <div className="instance-operation-copy">
      <Space wrap><StatusTag value={operationTask.status} /><Typography.Text strong>{translateCode(t, operationTask.kind, 'taskKind')}</Typography.Text><Typography.Text type="secondary">· {translateCode(t, operationTask.stage, 'taskStage')}</Typography.Text></Space>
      {activeTask
        ? <>
          <Typography.Paragraph type="secondary">{translateCode(t, operationTask.message, 'taskMessage')}</Typography.Paragraph>
          {isTaskCancellationPending(operationTask)
            ? <Typography.Text type="warning" className="instance-operation-next">{t('taskCancelPending')}</Typography.Text>
            : deploymentHandoff?.state === 'active' && deploymentHandoff.task.id === operationTask.id && <div className="instance-operation-next">
              {deploymentNextStep && <Typography.Text strong>{t('deploymentAutomaticNextStep', { step: t(`deploymentNextStep_${deploymentNextStep}`) })}</Typography.Text>}
              <Typography.Text type="secondary">{t('deploymentInProgressNextStep')}</Typography.Text>
            </div>}
        </>
        : <TaskFailureGuidance task={operationTask} hostName={item.hostName} />}
    </div>
    {activeTask && <Progress className="instance-operation-progress" percent={operationTask.progress} status="active" size="small" />}
    <Space wrap className="instance-operation-actions">
      {failedHostRecoveryPath && <Button type="primary" icon={<CloudServerOutlined />} onClick={() => navigate(failedHostRecoveryPath)}>{t('inspectFailedHost')}</Button>}
      {canOperate && failedTask && !activeTask && !failedHostRecoveryPath && taskRetry.failure?.taskId !== failedTask.id && <Button type="primary" icon={<ReloadOutlined />} loading={taskRetry.submittingTaskID === failedTask.id} disabled={Boolean(actioning && actioning !== 'retry-task')} onClick={() => void retryTask()}>{t('retryTask')}</Button>}
      {canOperate && canReviewIncompleteDeploymentCleanup(operationTask) && <Button danger icon={<DeleteOutlined />} disabled={!!actioning} onClick={() => setDeleteOpen(true)}>{t('deleteFailedDatabase')}</Button>}
      {canOperate && activeTask && canCancelTask(operationTask) && <Popconfirm title={t('cancelDeployment')} description={t(operationTask.status === 'queued' ? 'cancelQueuedTaskConfirm' : 'cancelTaskConfirm')} okText={t('confirm')} cancelText={t('cancel')} onConfirm={() => void cancelOperationTask(operationTask)}><Button danger icon={<CloseCircleOutlined />} loading={actioning === 'cancel-task'} disabled={!!actioning && actioning !== 'cancel-task'}>{t('cancelDeployment')}</Button></Popconfirm>}
      <Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewTask')}</Button>
    </Space>
    {deploymentCancellationFailure && <Alert className="instance-operation-action-error" type="error" showIcon message={t('deploymentCancelFailed')} description={<div className="instance-operation-action-error-copy"><span>{deploymentCancellationFailure.message}</span><span>{t(canCancelTask(operationTask) ? 'deploymentCancelFailedRetryHint' : 'deploymentCancelFailedRefreshHint')}</span></div>} />}
  </div>

  const taskRetryRequestPanel = taskRetry.failure && taskRetry.evidence && <TaskRetryRequestRecovery
    className="instance-page-alert"
    failure={taskRetry.failure}
    evidence={taskRetry.evidence}
    refreshError={taskRetry.refreshError}
    refreshing={taskRetry.refreshing}
    submittingTaskID={taskRetry.submittingTaskID}
    onRetry={(task) => void retryTask(task)}
    onRefresh={() => void refreshTaskRetryEvidence()}
    onOpenTask={(task) => navigate(`/tasks?task=${encodeURIComponent(task.id)}`)}
    onClose={taskRetry.clear}
  />

  const recoveryConfirmationPanel = requestedRecoveryTaskID && activeTab === 'overview' && (taskInventoryState === 'loading'
    ? <Alert className="recovery-confirmation-alert" type="info" showIcon message={t('recoveryConfirmationLoadingTitle')} description={t('recoveryConfirmationLoadingHint')} />
    : taskInventoryState === 'error'
      ? <Alert className="recovery-confirmation-alert" type="warning" showIcon message={t('recoveryConfirmationLoadFailedTitle')} description={taskInventoryError || t('recoveryConfirmationLoadFailedHint')} action={<Space wrap><Button size="small" loading={pageLoading} onClick={() => void load()}>{t('retry')}</Button><Button size="small" type="text" onClick={finishRecoveryConfirmation}>{t('finishRecoveryConfirmation')}</Button></Space>} />
      : !recoveryConfirmationTask
        ? <Alert className="recovery-confirmation-alert" type="warning" showIcon message={t('recoveryConfirmationUnavailableTitle')} description={t('recoveryConfirmationUnavailableHint')} action={<Button size="small" onClick={finishRecoveryConfirmation}>{t('finishRecoveryConfirmation')}</Button>} />
        : !operationTask && <Alert
          className="recovery-confirmation-alert"
          type={recoveryPhase === 'ready' || recoveryPhase === 'stopped' ? 'success' : recoveryPhase === 'converging' ? 'info' : 'warning'}
          showIcon
          message={t(recoveryPhase === 'converging' ? 'recoveryConfirmationConvergingTitle' : 'recoveryConfirmationTitle')}
          description={<div className="recovery-confirmation-body">
            <Typography.Text>{t(`recoveryConfirmationHint_${recoveryPhase}`, { operation: translateCode(t, recoveryConfirmationTask.kind, 'taskKind'), status: translateCode(t, item.status) })}</Typography.Text>
            {!canReadCredentials && recoveryPhase === 'ready' && <Typography.Text type="secondary">{t('recoveryConfirmationRestricted')}</Typography.Text>}
            <div className="recovery-confirmation-facts">
              <div><Typography.Text type="secondary">{t('recoveryConfirmationOperation')}</Typography.Text><Typography.Text strong>{translateCode(t, recoveryConfirmationTask.kind, 'taskKind')}</Typography.Text></div>
              <div><Typography.Text type="secondary">{t('recoveryConfirmationTaskResult')}</Typography.Text><StatusTag value={recoveryConfirmationTask.status} /></div>
              <div><Typography.Text type="secondary">{t('recoveryConfirmationCurrentState')}</Typography.Text>{recoveryPhase === 'converging' ? <Tag color="processing">{t('recoveryConfirmationHealthChecking')}</Tag> : <StatusTag value={item.status} />}</div>
              <div><Typography.Text type="secondary">{t('recoveryConfirmationLastHealthy')}</Typography.Text><Typography.Text strong>{item.lastHealthyAt ? formatDateTime(item.lastHealthyAt, i18n.language, timezone) : t('notReported')}</Typography.Text></div>
            </div>
            <Space wrap className="recovery-confirmation-actions">
              {canReadCredentials && recoveryPhase === 'ready' && <Button type="primary" size="small" icon={<CopyOutlined />} loading={connectionLoading} onClick={showConnectionHandoff}>{t('showConnectionHandoff')}</Button>}
              {recoveryPhase === 'converging' && <Button type="primary" size="small" icon={<ReloadOutlined />} loading={actioning === 'refresh-lifecycle-state'} disabled={!!actioning && actioning !== 'refresh-lifecycle-state'} onClick={() => void refreshLifecycleState()}>{t('refreshHealthStatus')}</Button>}
              <Button size="small" onClick={() => navigate(`/tasks?task=${encodeURIComponent(recoveryConfirmationTask.id)}`)}>{t('viewRecoveryTask')}</Button>
              {recoveryPhase !== 'ready' && <Button size="small" onClick={() => changeTab('logs')}>{t('viewInstanceLogs')}</Button>}
              <Button size="small" type="text" onClick={finishRecoveryConfirmation}>{t('finishRecoveryConfirmation')}</Button>
            </Space>
          </div>}
        />)

  const deploymentReadyPanel = !requestedRecoveryTaskID && !operationTask && activeTab === 'overview' && deploymentHandoff?.state === 'ready' && <div className="instance-operation is-ready">
    <div className="instance-operation-copy">
      <Space wrap><StatusTag value={deploymentHandoff.task.status} /><Typography.Text strong>{t('deploymentReadyTitle')}</Typography.Text></Space>
      <Typography.Paragraph type="secondary">{t(canReadCredentials ? 'deploymentReadyHint' : 'deploymentReadyRestrictedHint')}</Typography.Paragraph>
    </div>
    <Space wrap className="instance-operation-actions">
      {canReadCredentials && <Button type="primary" icon={<CopyOutlined />} loading={connectionLoading} onClick={showConnectionHandoff}>{t('showConnectionHandoff')}</Button>}
      <Button onClick={() => navigate(`/tasks?task=${deploymentHandoff.task.id}`)}>{t('viewDeploymentTask')}</Button>
    </Space>
  </div>

  const healthDescription = item.statusMessage
    ? translateCode(t, item.statusMessage, 'statusMessage')
    : item.status === 'running'
      ? t('noHealthIssue')
      : item.status === 'stopped'
        ? t('healthStopped')
        : item.status === 'provisioning'
          ? t('healthProvisioning')
          : item.status === 'degraded'
            ? t('healthDegraded')
            : t('healthUnavailable')
  const healthIcon = item.status === 'running' ? <CheckCircleOutlined /> : item.status === 'degraded' || item.status === 'provisioning' ? <WarningOutlined /> : item.status === 'failed' ? <CloseCircleOutlined /> : <PauseCircleOutlined />
  const healthTone = item.status === 'running' ? 'success' : item.status === 'degraded' || item.status === 'provisioning' ? 'warning' : item.status === 'failed' ? 'error' : 'neutral'

  const overview = <Row gutter={[16, 16]}>
    <Col xs={24} xl={16}><Card title={t('databaseOverview')}><Descriptions column={{ xs: 1, md: 2 }} items={[
      { key: 'status', label: t('status'), children: <StatusTag value={item.status} /> },
      { key: 'template', label: t('template'), children: `${item.templateName} ${item.templateVersion}` },
      { key: 'host', label: t('host'), children: <Button type="link" className="description-link" onClick={() => navigate(`/hosts?host=${item.hostId}`)}>{item.hostName}</Button> },
      { key: 'resource', label: t('resources'), children: `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },
      { key: 'port', label: t('port'), children: `${item.bindAddress}:${item.hostPort} → ${item.containerPort}` },
      { key: 'created', label: t('createdAt'), children: formatDateTime(item.createdAt, i18n.language, timezone) },
    ]} /></Card></Col>
    <Col xs={24} xl={8}><Card title={t('health')} className="health-summary-card"><div className={`health-summary-icon is-${healthTone}`}>{healthIcon}</div><div className="health-summary-copy"><Space><StatusTag value={item.status} /><Typography.Text strong>{t('currentRuntimeState')}</Typography.Text></Space><Typography.Paragraph type="secondary">{healthDescription}</Typography.Paragraph></div><div className="health-facts"><div><Typography.Text type="secondary">{t('lastHealthy')}</Typography.Text><Typography.Text>{item.lastHealthyAt ? formatDateTime(item.lastHealthyAt, i18n.language, timezone) : t('notReported')}</Typography.Text></div><div><Typography.Text type="secondary">{t('restartFailures')}</Typography.Text><Typography.Text>{item.restartFailures}</Typography.Text></div></div></Card></Col>
  </Row>

  const connectionErrorPanel = connectionError && <Alert className="connection-error-alert" type="error" showIcon message={t('connectionLoadFailed')} description={<div className="connection-error-description"><span>{connectionError}</span><span className="connection-error-hint">{t(connection ? 'connectionRefreshFailedHint' : 'connectionLoadFailedHint')}</span></div>} action={<Button size="small" loading={connectionLoading} onClick={() => void loadConnection()}>{t('retry')}</Button>} />
  const connectionAuthentication = connection?.authentication || 'password'
  const connectionTab = <Card title={t('connectionCredentials')} className="connection-card">
    <Descriptions className="connection-handoff-context" title={t('connectionHandoffContextTitle')} size="small" bordered column={{ xs: 1, md: 2 }} items={[
      { key: 'database', label: t('database'), children: `${item.templateName} ${item.templateVersion}` },
      { key: 'status', label: t('status'), children: <StatusTag value={item.status} /> },
      { key: 'host', label: t('host'), span: 2, children: item.hostName },
    ]} />
    {item.status !== 'running' && <Alert className="connection-status-alert" type="warning" showIcon message={t('connectionAvailabilityAffected')} description={t('connectionAvailabilityAffectedHint', { status: translateCode(t, item.status) })} />}
    {!canReadCredentials
      ? <div className="connection-gate"><div className="connection-gate-icon"><LockOutlined /></div><Typography.Title level={4}>{t('connectionRoleRestricted')}</Typography.Title><Typography.Paragraph type="secondary">{t('connectionRoleRestrictedHint')}</Typography.Paragraph></div>
      : !connection
        ? <div className="connection-gate"><div className="connection-gate-icon"><LockOutlined /></div><Typography.Title level={4}>{t('connectionProtectedTitle')}</Typography.Title><Typography.Paragraph type="secondary">{t('connectionProtectedDescription')}</Typography.Paragraph>{connectionErrorPanel || <Button type="primary" loading={connectionLoading} onClick={() => void loadConnection()}>{t('showConnectionDetails')}</Button>}</div>
        : <>
          {connectionErrorPanel}
          {connectionAuthentication !== 'password' && <Alert className="connection-authentication-alert" type="warning" showIcon message={t('nonPasswordAuthenticationTitle')} description={t(`nonPasswordAuthenticationHint_${connectionAuthentication}`)} />}
          <div className="connection-toolbar"><div><Typography.Text strong>{t('connectionReady')}</Typography.Text><Typography.Paragraph type="secondary">{t('connectionAuditNotice')}</Typography.Paragraph></div><Space wrap className="connection-actions"><Button type="primary" icon={<CopyOutlined />} onClick={() => void copyText(connectionHandoffText(item, connection, t)).then(() => message.success(t('connectionHandoffCopied'))).catch((error) => message.error(errorMessage(error)))}>{t('copyConnectionHandoff')}</Button><Button icon={<CopyOutlined />} onClick={() => void copyText(environmentFile(connection)).then(() => message.success(t('environmentCopied'))).catch((error) => message.error(errorMessage(error)))}>{t('copyEnvironment')}</Button><Button icon={<EyeInvisibleOutlined />} onClick={() => { setConnection(null); setConnectionError('') }}>{t('hideConnectionDetails')}</Button><Button icon={<ReloadOutlined />} loading={connectionLoading} onClick={() => void loadConnection()}>{t('refresh')}</Button></Space></div>
          <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[
            { key: 'authentication', label: t('authentication'), children: t(`authenticationMode_${connectionAuthentication}`) },
            { key: 'address', label: t('address'), children: <Typography.Text copyable={{ text: connection.address, icon: <CopyOutlined /> }}>{connection.address}</Typography.Text> },
            { key: 'port', label: t('port'), children: <Typography.Text copyable={{ text: String(connection.port), icon: <CopyOutlined /> }}>{connection.port}</Typography.Text> },
            ...(connection.username ? [{ key: 'username', label: t('username'), children: <Typography.Text copyable={{ text: connection.username, icon: <CopyOutlined /> }}>{connection.username}</Typography.Text> }] : []),
            ...(connectionAuthentication === 'password' && connection.password ? [{ key: 'password', label: t('password'), children: <Typography.Text code copyable={{ text: connection.password, icon: <CopyOutlined /> }}>{connection.password}</Typography.Text> }] : []),
            ...(connection.database ? [{ key: 'database', label: t('database'), children: <Typography.Text copyable={{ text: connection.database, icon: <CopyOutlined /> }}>{connection.database}</Typography.Text> }] : []),
          ]} />
          <div className="connection-strings"><div className="connection-string"><Typography.Text type="secondary">{t('uri')}</Typography.Text><Typography.Text code copyable={{ text: connection.uri, icon: <CopyOutlined /> }}>{connection.uri}</Typography.Text></div>{connection.jdbc && <div className="connection-string"><Typography.Text type="secondary">{t('jdbc')}</Typography.Text><Typography.Text code copyable={{ text: connection.jdbc, icon: <CopyOutlined /> }}>{connection.jdbc}</Typography.Text></div>}</div>
        </>}
  </Card>

  const logsTab = <Card className="ops-panel" loading={logsLoading && !logs && !logsError} extra={<Space wrap><Select aria-label={t('logLines')} value={logTail} onChange={setLogTail} options={[100, 500, 1000, 5000].map((value) => ({ value, label: t('logLineCount', { count: value }) }))} /><Space size={6}><Switch size="small" checked={logsAutoRefresh} onChange={setLogsAutoRefresh} /><Typography.Text type="secondary">{t('autoRefresh')}</Typography.Text></Space><Button icon={<ReloadOutlined />} loading={logsLoading} onClick={() => void loadLogs()}>{t('refresh')}</Button><Button icon={<DownloadOutlined />} href={`/api/v1/instances/${id}/logs?tail=${logTail}&download=true`}>{t('download')}</Button></Space>} title={<Space>{t('logs')}{logsUpdatedAt && <Typography.Text type="secondary" className="logs-updated">{t('lastRefreshedAt', { time: formatTime(logsUpdatedAt, i18n.language, timezone) })}</Typography.Text>}</Space>}>{logsError && <Alert className="ops-alert" type="error" showIcon message={t('logsLoadFailed')} description={logsError} action={<Button size="small" onClick={() => void loadLogs()}>{t('retry')}</Button>} />}{logs ? <pre className="log-viewer">{logs}</pre> : !logsError && <EmptyState compact description={t('logsEmptyDescription')} />}</Card>

  const detailActions = canOperate ? <Space wrap className="instance-detail-actions">
    {canStart && <Button type="primary" icon={<PlayCircleOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('start')}>{t('start')}</Button>}
    {canStopOrRestart && <Button icon={<PauseCircleOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('stop')}>{t('stop')}</Button>}
    {canStopOrRestart && <Button icon={<ReloadOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('restart')}>{t('restart')}</Button>}
    <Button danger icon={<DeleteOutlined />} disabled={item.status === 'deleting' || !!actioning} onClick={() => setDeleteOpen(true)}>{t('delete')}</Button>
  </Space> : undefined

  return <>
    <PageHeader title={<Space><Button type="text" size="small" aria-label={t('databases')} title={t('databases')} icon={<LeftOutlined />} onClick={() => navigate('/instances')} /><DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" />{item.name}<StatusTag value={item.status} /></Space>} description={`${item.templateName} ${item.templateVersion} · ${item.hostName}`} />
    {pageError && <Alert className="instance-page-alert" type="warning" showIcon message={t('instanceRefreshFailed')} description={pageError} action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} />}
    {lifecycleRequestFailurePanel}
    {taskRetryRequestPanel}
    {operationPanel}
    {recoveryConfirmationPanel}
    {deploymentReadyPanel}
    <Tabs className="instance-detail-tabs" activeKey={activeTab} onChange={changeTab} tabBarExtraContent={detailActions} items={[
      { key: 'overview', label: t('overviewTab'), children: overview },
      { key: 'connection', label: t('connection'), children: connectionTab },
      { key: 'logs', label: t('logs'), children: logsTab },
    ]} />

    <Modal
      title={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'instanceStopConfirmTitle' : lifecycleConfirmAction === 'restart' ? 'instanceRestartConfirmTitle' : 'instanceStartConfirmTitle', { name: item.name }) : ''}
      open={!!lifecycleConfirmAction}
      onCancel={() => { if (!actioning) setLifecycleConfirmAction(undefined) }}
      onOk={() => void submitLifecycleAction()}
      okText={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'confirmInstanceStop' : lifecycleConfirmAction === 'restart' ? 'confirmInstanceRestart' : 'confirmInstanceStart') : t('confirm')}
      cancelText={t('cancel')}
      confirmLoading={actioning === lifecycleConfirmAction}
      closable={!actioning}
      maskClosable={!actioning}
      okButtonProps={{ danger: lifecycleConfirmAction === 'stop', disabled: !lifecycleConfirmationCanSubmit || (!!actioning && actioning !== lifecycleConfirmAction) }}
      destroyOnHidden
    >
      <div className="instance-action-confirm">
        <Alert type={lifecycleConfirmAction === 'stop' || lifecycleConfirmAction === 'restart' ? 'warning' : 'info'} showIcon message={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'instanceStopConfirmMessage' : lifecycleConfirmAction === 'restart' ? 'instanceRestartConfirmMessage' : 'instanceStartConfirmMessage') : ''} description={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'instanceStopConfirmImpact' : lifecycleConfirmAction === 'restart' ? 'instanceRestartConfirmImpact' : 'instanceStartConfirmImpact') : ''} />
        <div><Typography.Text strong>{t('instanceActionTarget')}</Typography.Text><div className="instance-action-target"><Tag>{item.name} · {translateCode(t, item.status)}</Tag></div></div>
        {lifecycleRequestFailure && lifecycleRequestFailure.action === lifecycleConfirmAction && <Alert type="error" showIcon message={t('instanceActionRequestFailed', { action: t(lifecycleRequestFailure.action) })} description={<div className="instance-action-request-description"><div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{lifecycleRequestFailure.message}</Typography.Text></div><div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t('instanceActionRequestImpact')}</Typography.Text></div><div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(instanceLifecycleRequestRecoveryKey(lifecycleRequestFailure.code))}</Typography.Text></div></div>} />}
      </div>
    </Modal>

    <InstanceDeleteModal
      instanceId={item.id}
      instanceName={item.name}
      open={deleteOpen}
      onClose={() => setDeleteOpen(false)}
      onDeleteQueued={handleDeleteQueued}
      onOpenTask={handleOpenTask}
      onInstanceMissing={handleInstanceMissing}
    />
  </>
}
