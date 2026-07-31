import { ArrowRightOutlined, CloseCircleOutlined, CloudServerOutlined, DatabaseOutlined, ReloadOutlined, RedoOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Drawer, Grid, Input, Pagination, Popconfirm, Progress, Select, Space, Table, Tag, Timeline, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { RestoreVerificationFacts } from '../components/RestoreVerificationFacts'
import { TaskFailureGuidance } from '../components/TaskFailureGuidance'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { ApiError, api, errorMessage } from '../lib/api'
import { safeCreateReturnPath } from '../lib/deployment-continuation'
import { instanceDeleteOutcome } from '../lib/instance-delete-outcome'
import { formatCompactDateTime, formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { taskFailureGuidance } from '../lib/task-failure'
import { taskHostRecoveryPathForTask, taskRecoveryHostID } from '../lib/task-recovery'
import { taskRetryRequestEvidence, type TaskRetryRequestFailure } from '../lib/task-retry-request'
import { taskResourceReference } from '../lib/task-resource'
import { restoreVerification } from '../lib/restore-verification'
import { canCancelTask, deploymentTaskJourney, isTaskCancellationPending } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import type { Host, Instance, Task } from '../lib/types'

interface TaskLog { id: number; level: string; message: string; createdAt: string }
interface ResourceLink { label: string; path?: string; icon?: ReactNode }

export function TasksPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { user } = useAuth()
  const { canOperate, canReadCredentials } = permissionsFor(user!)
  const { message } = App.useApp()
  const screens = Grid.useBreakpoint()
  const navigate = useNavigate()
  const notifyTask = useTaskNotification()
  const [params, setParams] = useSearchParams()
  const taskID = params.get('task')
  const continueTo = safeCreateReturnPath(params.get('continue'))
  const [items, setItems] = useState<Task[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [resourceDataError, setResourceDataError] = useState('')
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<Task | null>(null)
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [logsError, setLogsError] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [actioning, setActioning] = useState('')
  const [actionError, setActionError] = useState('')
  const [retryRequestFailure, setRetryRequestFailure] = useState<TaskRetryRequestFailure | null>(null)
  const [retryEvidenceItems, setRetryEvidenceItems] = useState<Task[]>([])
  const [retryEvidenceRefreshing, setRetryEvidenceRefreshing] = useState(false)
  const [retryEvidenceError, setRetryEvidenceError] = useState('')
  const [search, setSearch] = useState('')
  const [resourceType, setResourceType] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams()
      if (status) query.set('status', status)
      if (resourceType) query.set('resourceType', resourceType)
      const value = await api<{ items: Task[] }>(`/tasks${query.size ? `?${query}` : ''}`)
      setItems(value.items)
      setListError('')
      return value.items
    } catch (error) {
      setListError(errorMessage(error))
      return undefined
    } finally {
      setLoading(false)
    }
  }, [resourceType, status])

  const loadResources = useCallback(async () => {
    const [hostResponse, instanceResponse] = await Promise.allSettled([
      api<{ items: Host[] }>('/hosts'),
      api<{ items: Instance[] }>('/instances'),
    ])
    if (hostResponse.status === 'fulfilled') setHosts(hostResponse.value.items)
    if (instanceResponse.status === 'fulfilled') setInstances(instanceResponse.value.items)
    const failed = [hostResponse, instanceResponse].find((result) => result.status === 'rejected')
    setResourceDataError(failed?.status === 'rejected' ? errorMessage(failed.reason) : '')
  }, [])

  const loadDetail = useCallback(async (id: string, foreground = false) => {
    if (foreground) {
      setDetailLoading(true)
      setDetailError('')
      setSelected(null)
      setLogs([])
      setLogsError('')
    }
    const [taskResponse, logsResponse] = await Promise.allSettled([
      api<Task>(`/tasks/${id}`),
      api<{ items: TaskLog[] }>(`/tasks/${id}/logs`),
    ])
    if (taskResponse.status === 'fulfilled') {
      setSelected(taskResponse.value)
      setDetailError('')
    } else {
      setDetailError(errorMessage(taskResponse.reason))
    }
    if (logsResponse.status === 'fulfilled') {
      setLogs(logsResponse.value.items)
      setLogsError('')
    } else {
      setLogsError(errorMessage(logsResponse.reason))
    }
    if (foreground) setDetailLoading(false)
  }, [])

  useEffect(() => { void loadResources() }, [loadResources])
  useEffect(() => {
    if (taskID) void loadDetail(taskID, true)
    else { setSelected(null); setLogs([]); setLogsError(''); setDetailError(''); setActionError('') }
  }, [loadDetail, taskID])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load(); if (taskID) void loadDetail(taskID) }, 3000)
    return () => clearInterval(timer)
  }, [load, loadDetail, taskID])

  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts])
  const instanceNames = useMemo(() => new Map(instances.map((instance) => [instance.id, instance.name])), [instances])
  const compactLayout = screens.md === false
  const resourceLink = useCallback((task: Task): ResourceLink => {
    const deleteOutcome = instanceDeleteOutcome(task)
    if (deleteOutcome) return { label: deleteOutcome.instanceName, icon: <DatabaseOutlined /> }
    const reference = taskResourceReference(task)
    const label = reference.lookupType === 'host' && reference.lookupID
      ? hostNames.get(reference.lookupID) || reference.lookupID.slice(0, 8)
      : reference.lookupType === 'instance' && reference.lookupID
        ? instanceNames.get(reference.lookupID) || reference.lookupID.slice(0, 8)
        : reference.fallbackID?.slice(0, 8) || '—'
    const icon = reference.lookupType === 'host'
      ? <CloudServerOutlined />
      : reference.lookupType === 'instance'
        ? <DatabaseOutlined />
        : undefined
    return { label, path: reference.path, icon }
  }, [hostNames, instanceNames])

  const closeDetail = () => { setSelected(null); setLogs([]); setLogsError(''); setDetailError(''); setActionError(''); setParams({}, { replace: true }) }
  const continueCreation = () => { if (!continueTo) return; setSelected(null); setLogs([]); setLogsError(''); setDetailError(''); setActionError(''); navigate(continueTo) }
  const goToResource = (task: Task) => { const resource = resourceLink(task); if (!resource.path) return; closeDetail(); navigate(resource.path) }
  const canRetry = (task: Task) => ['failed', 'canceled', 'interrupted'].includes(task.status)
  const retryEvidence = useMemo(
    () => retryRequestFailure ? taskRetryRequestEvidence(retryRequestFailure, retryEvidenceItems) : undefined,
    [retryEvidenceItems, retryRequestFailure],
  )
  const retryAllowed = (task: Task) => retryRequestFailure?.taskId !== task.id || retryEvidence?.canRetry === true
  const openTask = (id: string) => setParams(continueTo ? { task: id, continue: continueTo } : { task: id })

  const action = async (item: Task, name: 'cancel' | 'retry') => {
    const key = `${item.id}:${name}`
    const attemptedAt = new Date().toISOString()
    try {
      setActioning(key)
      setActionError('')
      if (name === 'retry') {
        setRetryRequestFailure(null)
        setRetryEvidenceItems([])
        setRetryEvidenceError('')
        const retried = await api<Task>(`/tasks/${item.id}/retry`, { method: 'POST', body: {} })
        notifyTask(retried)
        openTask(retried.id)
      } else {
        const canceled = await api<Task>(`/tasks/${item.id}/cancel`, { method: 'POST', body: {} })
        message.success(t(canceled.status === 'canceled' ? 'taskCanceledImmediately' : 'cancelRequested'))
        setItems((current) => current.map((task) => task.id === canceled.id ? canceled : task))
        if (taskID === item.id) {
          setSelected(canceled)
          await loadDetail(item.id)
        }
      }
      await load()
    } catch (error) {
      if (name === 'cancel') {
        setActionError(errorMessage(error))
      } else {
        const failure: TaskRetryRequestFailure = {
          taskId: item.id,
          code: error instanceof ApiError ? error.code : 'network_error',
          message: errorMessage(error),
          serverRejected: error instanceof ApiError,
          attemptedAt,
          evidenceChecks: 0,
        }
        try {
          const evidenceResponse = await api<{ items: Task[] }>('/tasks')
          const confirmedFailure = { ...failure, evidenceChecks: 1 }
          const evidence = taskRetryRequestEvidence(confirmedFailure, evidenceResponse.items)
          setRetryEvidenceItems(evidenceResponse.items)
          setRetryEvidenceError('')
          if (evidence.successor) {
            notifyTask(evidence.successor)
            openTask(evidence.successor.id)
          } else {
            setRetryRequestFailure(confirmedFailure)
          }
        } catch (evidenceError) {
          setRetryEvidenceError(errorMessage(evidenceError))
          setRetryRequestFailure(failure)
        }
        if (taskID === item.id) await loadDetail(item.id)
        await load()
      }
    } finally {
      setActioning('')
    }
  }

  const refreshRetryEvidence = async () => {
    if (!retryRequestFailure) return
    try {
      setRetryEvidenceRefreshing(true)
      setRetryEvidenceError('')
      const evidenceResponse = await api<{ items: Task[] }>('/tasks')
      const nextFailure = { ...retryRequestFailure, evidenceChecks: retryRequestFailure.evidenceChecks + 1 }
      const evidence = taskRetryRequestEvidence(nextFailure, evidenceResponse.items)
      setRetryEvidenceItems(evidenceResponse.items)
      if (evidence.successor) {
        setRetryRequestFailure(null)
        notifyTask(evidence.successor)
        openTask(evidence.successor.id)
      } else {
        setRetryRequestFailure(nextFailure)
      }
      await load()
      if (taskID) await loadDetail(taskID)
    } catch (error) {
      setRetryEvidenceError(errorMessage(error))
    } finally {
      setRetryEvidenceRefreshing(false)
    }
  }

  const duration = (task: Task) => {
    if (!task.startedAt) return '—'
    const seconds = Math.max(0, Math.round(((task.finishedAt ? new Date(task.finishedAt) : new Date()).getTime() - new Date(task.startedAt).getTime()) / 1000))
    if (seconds < 60) return t('durationSeconds', { count: seconds })
    if (seconds < 3600) return t('durationMinutes', { count: Math.round(seconds / 60) })
    return t('durationHours', { count: Math.round(seconds / 360) / 10 })
  }
  const compactTime = (value: string) => formatCompactDateTime(value, i18n.language, timezone)
  const taskSummary = (task: Task) => restoreVerification(task)
    ? t('restoreTaskVerifiedSummary')
    : task.status === 'failed'
      ? t(taskFailureGuidance(task).causeKey)
      : task.errorCode
        ? t(`taskError_${task.errorCode}`, { defaultValue: i18n.language.startsWith('zh') ? t('taskError_task_failed') : task.errorMessage || task.errorCode })
        : task.errorMessage || translateCode(t, task.message, 'taskMessage')
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return items
    return items.filter((task) => {
      const resource = resourceLink(task)
      return [task.id, task.kind, translateCode(t, task.kind, 'taskKind'), resource.label, task.resourceType, task.stage, translateCode(t, task.stage, 'taskStage'), task.message, translateCode(t, task.message, 'taskMessage'), task.errorCode, task.errorMessage, taskSummary(task)].join(' ').toLowerCase().includes(needle)
    })
  }, [i18n.language, items, resourceLink, search, t])
  const hasFilters = !!(search || status || resourceType)
  const showFilters = items.length > 0 || hasFilters
  const maxPage = Math.max(1, Math.ceil(filteredItems.length / pageSize))
  const visibleItems = useMemo(() => filteredItems.slice((page - 1) * pageSize, page * pageSize), [filteredItems, page, pageSize])
  useEffect(() => { if (page > maxPage) setPage(maxPage) }, [maxPage, page])
  const clearFilters = () => { setSearch(''); setStatus(''); setResourceType(''); setLoading(true); setPage(1) }
  const listActions = <Button loading={loading} icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>
  const showList = !listError || items.length > 0
  const renderResource = (task: Task) => {
    const resource = resourceLink(task)
    return <div className="task-resource"><Tag>{translateCode(t, task.resourceType, 'resourceType')}</Tag>{resource.path ? <Button type="link" onClick={() => resource.path && navigate(resource.path)} icon={resource.icon}>{resource.label}</Button> : <Typography.Text>{resource.label}</Typography.Text>}</div>
  }
  const renderTaskActions = (task: Task) => {
    const retryKey = `${task.id}:retry`
    const cancelKey = `${task.id}:cancel`
    const deploymentJourney = deploymentTaskJourney(task)
    const deploymentDestination = deploymentJourney?.state === 'ready'
      ? canReadCredentials ? deploymentJourney.connectionPath : deploymentJourney.instancePath
      : undefined
    const recoveryPath = canRetry(task) && taskFailureGuidance(task).inspectHost ? taskHostRecoveryPathForTask(task) : undefined
    const retryable = canOperate && canRetry(task) && !recoveryPath
    const cancelable = canOperate && canCancelTask(task)
    if (!deploymentDestination && !recoveryPath && !retryable && !cancelable) return null
    return <Space className="task-table-actions">
      {deploymentDestination && <Button size="small" icon={<DatabaseOutlined />} onClick={() => navigate(deploymentDestination)}>{t(canReadCredentials ? 'openConnectionHandoff' : 'viewDatabase')}</Button>}
      {recoveryPath && <Button size="small" icon={<CloudServerOutlined />} onClick={() => navigate(recoveryPath)}>{t('inspectFailedHost')}</Button>}
      {retryable && <Button size="small" loading={actioning === retryKey} disabled={!retryAllowed(task) || (!!actioning && actioning !== retryKey)} icon={<RedoOutlined />} onClick={() => void action(task, 'retry')}>{t('retry')}</Button>}
      {cancelable && <Popconfirm title={t('cancelTask')} description={t(task.status === 'queued' ? 'cancelQueuedTaskConfirm' : 'cancelTaskConfirm')} okText={t('confirm')} cancelText={t('cancel')} onConfirm={() => void action(task, 'cancel')}><Button size="small" danger loading={actioning === cancelKey} disabled={!!actioning && actioning !== cancelKey} icon={<CloseCircleOutlined />}>{t('cancel')}</Button></Popconfirm>}
    </Space>
  }

  const columns = [
    { title: t('status'), dataIndex: 'status', width: 90, render: (value: string) => <StatusTag value={value} /> },
    { title: t('operation'), width: 170, render: (_: unknown, task: Task) => <div className="task-operation-cell"><Button className="task-operation-link" type="link" onClick={() => setParams({ task: task.id })}>{translateCode(t, task.kind, 'taskKind')}</Button><Typography.Text type="secondary">{compactTime(task.createdAt)}</Typography.Text></div> },
    { title: t('resource'), width: 160, render: (_: unknown, task: Task) => renderResource(task) },
    { title: t('progress'), width: 160, render: (_: unknown, task: Task) => <Progress percent={task.progress} status={task.status === 'failed' ? 'exception' : task.status === 'succeeded' ? 'success' : undefined} size="small" /> },
    { title: t('stage'), width: 220, render: (_: unknown, task: Task) => { const summary = taskSummary(task); return <div className="task-stage-cell"><Typography.Text strong>{translateCode(t, task.stage, 'taskStage')}</Typography.Text><Typography.Text type={task.status === 'failed' ? 'danger' : 'secondary'} ellipsis={{ tooltip: summary }}>{summary}</Typography.Text></div> } },
    { title: t('actions'), width: 150, align: 'right' as const, render: (_: unknown, task: Task) => renderTaskActions(task) || <Typography.Text type="secondary">—</Typography.Text> },
  ]

  const selectedResource = selected ? resourceLink(selected) : undefined
  const selectedRecoveryHostID = selected && taskFailureGuidance(selected).inspectHost ? taskRecoveryHostID(selected) : undefined
  const selectedRecoveryHost = selectedRecoveryHostID ? hosts.find((host) => host.id === selectedRecoveryHostID) : undefined
  const selectedRecoveryPath = selected && selectedRecoveryHostID ? taskHostRecoveryPathForTask(selected) : undefined
  const selectedRestoreVerification = selected ? restoreVerification(selected) : undefined
  const selectedDeleteOutcome = selected ? instanceDeleteOutcome(selected) : undefined
  const selectedDeploymentJourney = selected ? deploymentTaskJourney(selected) : undefined
  const selectedDeploymentDestination = selectedDeploymentJourney
    ? selectedDeploymentJourney.state === 'ready' && canReadCredentials
      ? selectedDeploymentJourney.connectionPath
      : selectedDeploymentJourney.instancePath
    : undefined
  const inspectRecoveryHost = () => {
    if (!selectedRecoveryPath) return
    closeDetail()
    navigate(selectedRecoveryPath)
  }
  const showResourceFooterAction = !!selectedResource?.path && !selectedDeploymentJourney && !selectedDeleteOutcome
  const hasDrawerLeadingAction = showResourceFooterAction || !!selectedDeleteOutcome || !!(canOperate && continueTo)
  const drawerFooter = selected ? <div className="task-drawer-footer">{hasDrawerLeadingAction && <Space>{showResourceFooterAction && <Button icon={<ArrowRightOutlined />} onClick={() => goToResource(selected)}>{t(selected.resourceType === 'backup' ? 'viewBackupCleanup' : 'viewResource')}</Button>}{selectedDeleteOutcome && <Button icon={<DatabaseOutlined />} onClick={() => { closeDetail(); navigate('/instances') }}>{t('backToInstances')}</Button>}{canOperate && continueTo && <Button type="primary" disabled={selected.status !== 'succeeded'} icon={<DatabaseOutlined />} onClick={continueCreation}>{t('continueCreateDatabase')}</Button>}</Space>}{canOperate && <Space className="task-drawer-actions">{canCancelTask(selected) && <Popconfirm title={t('cancelTask')} description={t(selected.status === 'queued' ? 'cancelQueuedTaskConfirm' : 'cancelTaskConfirm')} okText={t('confirm')} cancelText={t('cancel')} onConfirm={() => void action(selected, 'cancel')}><Button danger loading={actioning === `${selected.id}:cancel`} icon={<CloseCircleOutlined />}>{t('cancelTask')}</Button></Popconfirm>}{canRetry(selected) && !selectedRecoveryPath && <Button type="primary" disabled={!retryAllowed(selected)} loading={actioning === `${selected.id}:retry`} icon={<RedoOutlined />} onClick={() => void action(selected, 'retry')}>{t('retryTask')}</Button>}</Space>}</div> : undefined

  const retryRequestAlert = retryRequestFailure && retryEvidence ? <Alert
    className="task-retry-request-alert"
    type={retryEvidence.phase === 'ready' ? 'success' : retryEvidence.phase === 'unavailable' ? 'error' : 'warning'}
    showIcon
    closable
    aria-live="polite"
    message={t(retryRequestFailure.serverRejected ? 'taskRetryRequestRejectedTitle' : 'taskRetryRequestUnknownTitle')}
    description={<div className="task-retry-request-body">
      <div className="task-retry-request-grid">
        <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{retryEvidence.phase === 'blocked' && retryEvidence.blocker ? t('taskRetryRequestBlockedCause', { operation: translateCode(t, retryEvidence.blocker.kind, 'taskKind') }) : retryRequestFailure.serverRejected ? t(`error_${retryRequestFailure.code}`, { defaultValue: retryRequestFailure.message }) : retryRequestFailure.message}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t(retryRequestFailure.serverRejected ? 'taskRetryRequestRejectedImpact' : 'taskRetryRequestUnknownImpact')}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(`taskRetryRequestRecovery_${retryEvidence.phase}`)}</Typography.Text></div>
      </div>
      <div className="task-retry-request-evidence">
        <Typography.Text type="secondary">{t('taskRetryRequestErrorCode')}</Typography.Text>
        <Tag>{retryRequestFailure.code}</Tag>
      </div>
      {retryEvidence.blocker && <div className="task-retry-request-evidence">
        <Typography.Text type="secondary">{t('taskRetryRequestCurrentTask')}</Typography.Text>
        <StatusTag value={retryEvidence.blocker.status} />
        <Typography.Text strong>{translateCode(t, retryEvidence.blocker.kind, 'taskKind')}</Typography.Text>
        <Typography.Text code>{retryEvidence.blocker.id.slice(0, 8)}</Typography.Text>
      </div>}
      {retryEvidenceError && <Typography.Text className="task-retry-request-refresh-error" type="danger">{t('taskRetryEvidenceRefreshFailed', { error: retryEvidenceError })}</Typography.Text>}
    </div>}
    action={<Space wrap className="task-retry-request-actions">
      {retryEvidence.canRetry && retryEvidence.original && taskID !== retryRequestFailure.taskId && <Button size="small" type="primary" loading={actioning === `${retryEvidence.original.id}:retry`} icon={<RedoOutlined />} onClick={() => void action(retryEvidence.original!, 'retry')}>{t('retryTask')}</Button>}
      <Button size="small" loading={retryEvidenceRefreshing} icon={<ReloadOutlined />} onClick={() => void refreshRetryEvidence()}>{t('refreshTaskEvidence')}</Button>
      {retryEvidence.blocker && <Button size="small" onClick={() => openTask(retryEvidence.blocker!.id)}>{t('viewCurrentTask')}</Button>}
      {retryEvidence.original && resourceLink(retryEvidence.original).path && <Button size="small" onClick={() => goToResource(retryEvidence.original!)}>{t('viewResource')}</Button>}
    </Space>}
    onClose={() => { setRetryRequestFailure(null); setRetryEvidenceItems([]); setRetryEvidenceError('') }}
  /> : undefined

  return <>
    <PageHeader title={t('tasks')} description={t('tasksDescription')} />
    {listError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('taskListLoadFailed')} description={listError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {resourceDataError && <Alert className="instance-page-alert" type="warning" showIcon message={t('taskResourceDataLoadFailed')} description={resourceDataError} action={<Button size="small" onClick={() => void loadResources()}>{t('retry')}</Button>} />}
    {actionError && !taskID && <Alert className="instance-page-alert" type="error" showIcon closable message={t('taskActionFailed')} description={actionError} onClose={() => setActionError('')} />}
    {retryRequestFailure && taskID !== retryRequestFailure.taskId && <div className="instance-page-alert">{retryRequestAlert}</div>}
    {showFilters && <Card className="table-filter-card task-filter-card"><div className="task-filter-toolbar"><Input.Search allowClear aria-label={t('tasksSearchLabel')} placeholder={t('tasksSearchPlaceholder')} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} className="task-filter-search" /><Select aria-label={t('status')} value={status} onChange={(value) => { setLoading(true); setStatus(value); setPage(1) }} className="task-filter-status" options={[{ value: '', label: t('taskStatusAll') }, ...['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Select aria-label={t('resource')} value={resourceType} onChange={(value) => { setLoading(true); setResourceType(value); setPage(1) }} className="task-filter-resource" options={[{ value: '', label: t('allResources') }, ...['instance', 'host', 'backup'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Typography.Text type="secondary" className="task-filter-count" aria-live="polite">{search ? t('taskFilteredResultCount', { filtered: filteredItems.length, total: items.length }) : t('taskResultCount', { count: items.length })}</Typography.Text>{listActions}</div></Card>}
    {showList && (compactLayout
      ? <Card className="task-mobile-list-card" title={!showFilters ? t('tasks') : undefined} extra={!showFilters ? listActions : undefined}>
          {visibleItems.length
            ? <div className="task-mobile-list" role="list">{visibleItems.map((task) => {
                const summary = taskSummary(task)
                const actions = renderTaskActions(task)
                return <article className="task-mobile-item" role="listitem" key={task.id}>
                  <div className="task-mobile-item-header"><StatusTag value={task.status} /><Typography.Text type="secondary">{compactTime(task.createdAt)}</Typography.Text></div>
                  <Button className="task-operation-link task-mobile-operation" type="link" onClick={() => setParams({ task: task.id })}>{translateCode(t, task.kind, 'taskKind')}</Button>
                  <div className="task-mobile-meta"><Typography.Text type="secondary">{t('resource')}</Typography.Text>{renderResource(task)}</div>
                  <div className="task-mobile-stage"><div><Typography.Text strong>{translateCode(t, task.stage, 'taskStage')}</Typography.Text><Typography.Text type={task.status === 'failed' ? 'danger' : 'secondary'}>{summary}</Typography.Text></div><Progress percent={task.progress} status={task.status === 'failed' ? 'exception' : task.status === 'succeeded' ? 'success' : undefined} size="small" /></div>
                  {actions && <div className="task-mobile-actions">{actions}</div>}
                </article>
              })}</div>
            : <div className="task-mobile-empty"><EmptyState compact action={hasFilters ? clearFilters : undefined} actionLabel={t('clearFilters')} description={hasFilters ? t('tasksFilteredEmptyDescription') : t('tasksEmptyDescription')} /></div>}
          {filteredItems.length > pageSize && <Pagination className="task-mobile-pagination" simple current={page} pageSize={pageSize} total={filteredItems.length} showSizeChanger={false} onChange={setPage} />}
        </Card>
      : <Card className="task-table-card" title={!showFilters ? t('tasks') : undefined} extra={!showFilters ? listActions : undefined}><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} scroll={{ x: 900 }} pagination={{ current: page, pageSize, showSizeChanger: true, hideOnSinglePage: true, pageSizeOptions: [20, 50], onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize) } }} locale={{ emptyText: <EmptyState compact action={hasFilters ? clearFilters : undefined} actionLabel={t('clearFilters')} description={hasFilters ? t('tasksFilteredEmptyDescription') : t('tasksEmptyDescription')} /> }} /></Card>)}
    <Drawer title={selected ? <div className="task-drawer-title"><Typography.Text strong>{translateCode(t, selected.kind, 'taskKind')}</Typography.Text><Typography.Text code copyable={{ text: selected.id }}>{selected.id.slice(0, 8)}</Typography.Text></div> : t('taskDetails')} open={!!taskID} onClose={closeDetail} width={760} destroyOnHidden footer={drawerFooter}>
      {detailLoading ? <Card loading /> : detailError ? <Alert type="error" showIcon message={t('taskLoadFailed')} description={detailError} action={<Button size="small" onClick={() => taskID && void loadDetail(taskID, true)}>{t('retry')}</Button>} /> : selected && <div className="task-detail">
        {actionError && <Alert className="task-detail-alert" type="error" showIcon closable message={t('taskActionFailed')} description={actionError} onClose={() => setActionError('')} />}
        {retryRequestFailure?.taskId === selected.id && retryRequestAlert}
        <div className={`task-detail-summary is-${selected.status}`}><div><Space><StatusTag value={selected.status} /><Typography.Text strong>{translateCode(t, selected.message, 'taskMessage')}</Typography.Text></Space><Typography.Paragraph type="secondary">{t('taskSummaryDescription', { operation: translateCode(t, selected.kind, 'taskKind'), resource: selectedResource?.label || '—' })}</Typography.Paragraph></div><Progress percent={selected.progress} status={selected.status === 'failed' ? 'exception' : selected.status === 'succeeded' ? 'success' : undefined} /></div>
        {selectedDeploymentJourney && selectedDeploymentDestination && <Alert
          className="task-detail-alert deployment-task-next-step"
          type={selectedDeploymentJourney.state === 'ready' ? 'success' : selectedDeploymentJourney.state === 'incomplete' ? 'warning' : 'info'}
          showIcon
          aria-live="polite"
          message={t(`deploymentTask_${selectedDeploymentJourney.state}_title`)}
          description={t(selectedDeploymentJourney.state === 'ready' && !canReadCredentials ? 'deploymentTask_ready_restricted_hint' : `deploymentTask_${selectedDeploymentJourney.state}_hint`)}
          action={<Button size="small" type={selectedDeploymentJourney.state === 'ready' ? 'primary' : 'default'} icon={<DatabaseOutlined />} onClick={() => { closeDetail(); navigate(selectedDeploymentDestination) }}>{t(selectedDeploymentJourney.state === 'active' ? 'viewDeploymentProgress' : selectedDeploymentJourney.state === 'ready' && canReadCredentials ? 'openConnectionHandoff' : 'viewDatabase')}</Button>}
        />}
        {canOperate && continueTo && <Alert className="task-detail-alert" type={selected.status === 'succeeded' ? 'success' : selected.status === 'failed' ? 'warning' : 'info'} showIcon message={selected.status === 'succeeded' ? t('hostReadyContinue') : selected.status === 'failed' ? t('hostSetupFailedContinue') : t('hostSetupInProgress')} description={selected.status === 'succeeded' ? t('hostReadyContinueHint') : selected.status === 'failed' ? t('hostSetupFailedContinueHint') : t('hostSetupInProgressHint')} action={selected.status === 'succeeded' ? <Button size="small" type="primary" onClick={continueCreation}>{t('continueCreateDatabase')}</Button> : undefined} />}
        {isTaskCancellationPending(selected) && <Alert className="task-detail-alert" type="warning" showIcon message={t('taskCancelPending')} />}
        {selectedRestoreVerification && <Alert className="task-detail-alert restore-task-verification-alert" type="success" showIcon message={t('restoreTaskVerifiedTitle')} description={<div className="restore-verification-body"><Typography.Text>{t('restoreTaskVerifiedDescription')}</Typography.Text><RestoreVerificationFacts verification={selectedRestoreVerification} /></div>} />}
        {selectedDeleteOutcome && <Alert
          className="task-detail-alert instance-delete-outcome-alert"
          type="success"
          showIcon
          aria-live="polite"
          message={t('instanceDeleteOutcomeTitle', { name: selectedDeleteOutcome.instanceName })}
          description={<div className="instance-delete-outcome-body">
            <Typography.Text>{t('instanceDeleteOutcomeDescription')}</Typography.Text>
            <div className="instance-delete-outcome-facts">
              <div><Typography.Text type="secondary">{t('releasedPort')}</Typography.Text><Typography.Text strong>{selectedDeleteOutcome.releasedBindAddress}:{selectedDeleteOutcome.releasedHostPort}</Typography.Text></div>
              <div><Typography.Text type="secondary">{t('host')}</Typography.Text><Typography.Text strong>{selectedDeleteOutcome.hostName}</Typography.Text></div>
              <div><Typography.Text type="secondary">{t('cleanupScope')}</Typography.Text><Typography.Text strong>{t('instanceDeleteOutcomeCleanupScope')}</Typography.Text></div>
            </div>
          </div>}
        />}
        {(selected.status === 'failed' || selected.errorMessage) && <Alert className="task-detail-alert" type={selected.status === 'failed' ? 'error' : selected.status === 'canceled' ? 'info' : 'warning'} showIcon message={selected.status === 'failed' ? t('taskFailureTitle', { stage: translateCode(t, selected.stage, 'taskStage') }) : translateCode(t, selected.status)} description={selected.status === 'failed' ? <TaskFailureGuidance task={selected} hostName={selectedRecoveryHost?.name} /> : taskSummary(selected)} action={selectedRecoveryPath ? <Button type="primary" size="small" icon={<CloudServerOutlined />} onClick={inspectRecoveryHost}>{t('inspectFailedHost')}</Button> : undefined} />}
        <Descriptions className="task-detail-meta" bordered size="small" column={screens.sm ? 2 : 1} items={[
          { key: 'resource', label: t('resource'), children: selectedResource?.path ? <Button type="link" icon={selectedResource.icon} onClick={() => goToResource(selected)}>{selectedResource.label}</Button> : selectedResource?.label || '—' },
          { key: 'attempts', label: t('attempts'), children: selected.attempts },
          { key: 'created', label: t('createdAt'), children: formatDateTime(selected.createdAt, i18n.language, timezone) },
          { key: 'started', label: t('startedAt'), children: formatDateTime(selected.startedAt, i18n.language, timezone) },
          { key: 'finished', label: t('finishedAt'), children: formatDateTime(selected.finishedAt, i18n.language, timezone) },
          { key: 'duration', label: t('duration'), children: duration(selected) },
        ]} />
        <Card className="task-log-card" size="small" title={t('executionLog')}>
          {logsError && <Alert className="task-detail-alert" type="warning" showIcon message={t('taskLogsLoadFailed')} description={logsError} action={<Button size="small" onClick={() => taskID && void loadDetail(taskID)}>{t('retry')}</Button>} />}
          {logs.length ? <Timeline items={logs.map((log) => ({ color: log.level === 'error' ? 'red' : log.level === 'warning' ? 'orange' : 'blue', children: <div className="task-log-entry"><div className="task-log-entry-meta"><Typography.Text type="secondary">{formatDateTime(log.createdAt, i18n.language, timezone)}</Typography.Text><Tag color={log.level === 'error' ? 'red' : log.level === 'warning' ? 'orange' : 'blue'}>{log.level === 'error' ? t('failure') : log.level === 'warning' ? t('warning') : t('info')}</Tag></div><Typography.Text>{translateCode(t, log.message, 'taskMessage')}</Typography.Text></div> }))} /> : !logsError && <EmptyState compact description={t('noTaskLogs')} />}
        </Card>
      </div>}
    </Drawer>
  </>
}
