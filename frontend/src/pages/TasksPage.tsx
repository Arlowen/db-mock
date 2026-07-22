import { ArrowRightOutlined, CloseCircleOutlined, CloudServerOutlined, DatabaseOutlined, ReloadOutlined, RedoOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Drawer, Input, Popconfirm, Progress, Select, Space, Table, Tag, Timeline, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { formatCompactDateTime, formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { useTaskNotification } from '../lib/task-notification'
import type { Host, Instance, Task } from '../lib/types'

interface TaskLog { id: number; level: string; message: string; createdAt: string }
interface ResourceLink { label: string; path?: string; icon?: ReactNode }
const safeCreateReturnPath = (value: string | null) => value?.startsWith('/instances?create=1') ? value : ''

export function TasksPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const { message } = App.useApp()
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
  const [status, setStatus] = useState('')
  const [selected, setSelected] = useState<Task | null>(null)
  const [logs, setLogs] = useState<TaskLog[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [actioning, setActioning] = useState('')
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
    } catch (error) {
      setListError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [resourceType, status])

  const loadResources = useCallback(async () => {
    try {
      const [hostList, instanceList] = await Promise.all([api<{ items: Host[] }>('/hosts'), api<{ items: Instance[] }>('/instances')])
      setHosts(hostList.items)
      setInstances(instanceList.items)
    } catch (error) {
      message.error(errorMessage(error))
    }
  }, [message])

  const loadDetail = useCallback(async (id: string, foreground = false) => {
    if (foreground) {
      setDetailLoading(true)
      setDetailError('')
      setSelected(null)
      setLogs([])
    }
    try {
      const [task, result] = await Promise.all([api<Task>(`/tasks/${id}`), api<{ items: TaskLog[] }>(`/tasks/${id}/logs`)])
      setSelected(task)
      setLogs(result.items)
      setDetailError('')
    } catch (error) {
      setDetailError(errorMessage(error))
    } finally {
      if (foreground) setDetailLoading(false)
    }
  }, [])

  useEffect(() => { void loadResources() }, [loadResources])
  useEffect(() => {
    if (taskID) void loadDetail(taskID, true)
    else { setSelected(null); setLogs([]); setDetailError('') }
  }, [loadDetail, taskID])
  useEffect(() => {
    void load()
    const timer = window.setInterval(() => { void load(); if (taskID) void loadDetail(taskID) }, 3000)
    return () => clearInterval(timer)
  }, [load, loadDetail, taskID])

  const hostNames = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts])
  const instanceNames = useMemo(() => new Map(instances.map((instance) => [instance.id, instance.name])), [instances])
  const resourceLink = useCallback((task: Task): ResourceLink => {
    if (!task.resourceId) return { label: '—' }
    if (task.resourceType === 'host') return { label: hostNames.get(task.resourceId) || task.resourceId.slice(0, 8), path: `/hosts?host=${task.resourceId}`, icon: <CloudServerOutlined /> }
    if (task.resourceType === 'instance') return { label: instanceNames.get(task.resourceId) || task.resourceId.slice(0, 8), path: `/instances/${task.resourceId}`, icon: <DatabaseOutlined /> }
    return { label: task.resourceId.slice(0, 8) }
  }, [hostNames, instanceNames])

  const closeDetail = () => { setSelected(null); setLogs([]); setDetailError(''); setParams({}, { replace: true }) }
  const continueCreation = () => { if (!continueTo) return; setSelected(null); setLogs([]); setDetailError(''); navigate(continueTo) }
  const goToResource = (task: Task) => { const resource = resourceLink(task); if (!resource.path) return; closeDetail(); navigate(resource.path) }
  const canRetry = (task: Task) => ['failed', 'canceled', 'interrupted'].includes(task.status)
  const canCancel = (task: Task) => task.cancelable && !task.cancelAsked && ['queued', 'running'].includes(task.status)

  const action = async (item: Task, name: 'cancel' | 'retry') => {
    const key = `${item.id}:${name}`
    try {
      setActioning(key)
      if (name === 'retry') {
        const retried = await api<Task>(`/tasks/${item.id}/retry`, { method: 'POST', body: {} })
        notifyTask(retried)
        setParams(continueTo ? { task: retried.id, continue: continueTo } : { task: retried.id })
      } else {
        await api(`/tasks/${item.id}/cancel`, { method: 'POST', body: {} })
        message.success(t('cancelRequested'))
        if (taskID === item.id) await loadDetail(item.id)
      }
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
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
  const taskSummary = (task: Task) => task.errorCode ? t(`taskError_${task.errorCode}`, { defaultValue: i18n.language.startsWith('zh') ? t('taskError_task_failed') : task.errorMessage || task.errorCode }) : task.errorMessage || translateCode(t, task.message, 'taskMessage')
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return items
    return items.filter((task) => {
      const resource = resourceLink(task)
      return [task.id, task.kind, translateCode(t, task.kind, 'taskKind'), resource.label, task.resourceType, task.stage, translateCode(t, task.stage), task.message, translateCode(t, task.message, 'taskMessage'), task.errorCode, task.errorMessage, taskSummary(task)].join(' ').toLowerCase().includes(needle)
    })
  }, [i18n.language, items, resourceLink, search, t])
  const hasFilters = !!(search || status || resourceType)
  const maxPage = Math.max(1, Math.ceil(filteredItems.length / pageSize))
  useEffect(() => { if (page > maxPage) setPage(maxPage) }, [maxPage, page])
  const clearFilters = () => { setSearch(''); setStatus(''); setResourceType(''); setLoading(true); setPage(1) }

  const columns = [
    { title: t('status'), dataIndex: 'status', width: 90, render: (value: string) => <StatusTag value={value} /> },
    { title: t('operation'), width: 170, render: (_: unknown, task: Task) => <div className="task-operation-cell"><Button className="task-operation-link" type="link" onClick={() => setParams({ task: task.id })}>{translateCode(t, task.kind, 'taskKind')}</Button><Typography.Text type="secondary">{compactTime(task.createdAt)}</Typography.Text></div> },
    { title: t('resource'), width: 160, render: (_: unknown, task: Task) => { const resource = resourceLink(task); return <div className="task-resource"><Tag>{translateCode(t, task.resourceType, 'resourceType')}</Tag>{resource.path ? <Button type="link" onClick={() => resource.path && navigate(resource.path)} icon={resource.icon}>{resource.label}</Button> : <Typography.Text>{resource.label}</Typography.Text>}</div> } },
    { title: t('progress'), width: 160, render: (_: unknown, task: Task) => <Progress percent={task.progress} status={task.status === 'failed' ? 'exception' : task.status === 'succeeded' ? 'success' : undefined} size="small" /> },
    { title: t('stage'), width: 220, render: (_: unknown, task: Task) => { const summary = taskSummary(task); return <div className="task-stage-cell"><Typography.Text strong>{translateCode(t, task.stage)}</Typography.Text><Typography.Text type={task.errorMessage ? 'danger' : 'secondary'} ellipsis={{ tooltip: summary }}>{summary}</Typography.Text></div> } },
    { title: t('actions'), width: 110, align: 'right' as const, render: (_: unknown, task: Task) => { const retryKey = `${task.id}:retry`; const cancelKey = `${task.id}:cancel`; if (!canOperate || (!canRetry(task) && !canCancel(task))) return <Typography.Text type="secondary">—</Typography.Text>; return <Space className="task-table-actions">{canRetry(task) && <Button size="small" loading={actioning === retryKey} disabled={!!actioning && actioning !== retryKey} icon={<RedoOutlined />} onClick={() => void action(task, 'retry')}>{t('retry')}</Button>}{canCancel(task) && <Popconfirm title={t('cancelTask')} description={t('cancelTaskConfirm')} okText={t('confirm')} cancelText={t('cancel')} onConfirm={() => void action(task, 'cancel')}><Button size="small" danger loading={actioning === cancelKey} disabled={!!actioning && actioning !== cancelKey} icon={<CloseCircleOutlined />}>{t('cancel')}</Button></Popconfirm>}</Space> } },
  ]

  const selectedResource = selected ? resourceLink(selected) : undefined
  const selectedRecoveryHost = selected?.errorCode === 'ssh_timeout' && selected.hostId ? hosts.find((host) => host.id === selected.hostId) : undefined
  const inspectRecoveryHost = () => { if (!selectedRecoveryHost) return; closeDetail(); navigate(`/hosts?host=${selectedRecoveryHost.id}`) }
  const drawerFooter = selected ? <div className="task-drawer-footer"><Space><Button disabled={!selectedResource?.path} icon={<ArrowRightOutlined />} onClick={() => goToResource(selected)}>{t('viewResource')}</Button>{canOperate && continueTo && <Button type="primary" disabled={selected.status !== 'succeeded'} icon={<DatabaseOutlined />} onClick={continueCreation}>{t('continueCreateDatabase')}</Button>}</Space>{canOperate && <Space>{canCancel(selected) && <Popconfirm title={t('cancelTask')} description={t('cancelTaskConfirm')} okText={t('confirm')} cancelText={t('cancel')} onConfirm={() => void action(selected, 'cancel')}><Button danger loading={actioning === `${selected.id}:cancel`} icon={<CloseCircleOutlined />}>{t('cancelTask')}</Button></Popconfirm>}{canRetry(selected) && <Button type="primary" loading={actioning === `${selected.id}:retry`} icon={<RedoOutlined />} onClick={() => void action(selected, 'retry')}>{t('retryTask')}</Button>}</Space>}</div> : undefined

  return <>
    <PageHeader title={t('tasks')} description={t('tasksDescription')} actions={<Button loading={loading} icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>} />
    {listError && <Alert className="instance-page-alert" type="error" showIcon message={t('taskListLoadFailed')} description={listError} action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} />}
    <Card className="table-filter-card task-filter-card"><div className="task-filter-toolbar"><Input.Search allowClear aria-label={t('tasksSearchLabel')} placeholder={t('tasksSearchPlaceholder')} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} className="task-filter-search" /><Select aria-label={t('status')} value={status} onChange={(value) => { setLoading(true); setStatus(value); setPage(1) }} className="task-filter-status" options={[{ value: '', label: t('taskStatusAll') }, ...['queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Select aria-label={t('resource')} value={resourceType} onChange={(value) => { setLoading(true); setResourceType(value); setPage(1) }} className="task-filter-resource" options={[{ value: '', label: t('allResources') }, ...['instance', 'host'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Typography.Text type="secondary" className="task-filter-count" aria-live="polite">{search ? t('taskFilteredResultCount', { filtered: filteredItems.length, total: items.length }) : t('taskResultCount', { count: items.length })}</Typography.Text></div></Card>
    <Card className="task-table-card"><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} scroll={{ x: 900 }} pagination={{ current: page, pageSize, showSizeChanger: true, pageSizeOptions: [20, 50], onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize) } }} locale={{ emptyText: <EmptyState compact action={hasFilters ? clearFilters : undefined} actionLabel={t('clearFilters')} description={hasFilters ? t('tasksFilteredEmptyDescription') : t('tasksEmptyDescription')} /> }} /></Card>
    <Drawer title={selected ? <div className="task-drawer-title"><Typography.Text strong>{translateCode(t, selected.kind, 'taskKind')}</Typography.Text><Typography.Text code copyable={{ text: selected.id }}>{selected.id.slice(0, 8)}</Typography.Text></div> : t('taskDetails')} open={!!taskID} onClose={closeDetail} width={760} destroyOnHidden footer={drawerFooter}>
      {detailLoading ? <Card loading /> : detailError ? <Alert type="error" showIcon message={t('taskLoadFailed')} description={detailError} action={<Button size="small" onClick={() => taskID && void loadDetail(taskID, true)}>{t('retry')}</Button>} /> : selected && <div className="task-detail">
        <div className={`task-detail-summary is-${selected.status}`}><div><Space><StatusTag value={selected.status} /><Typography.Text strong>{translateCode(t, selected.message, 'taskMessage')}</Typography.Text></Space><Typography.Paragraph type="secondary">{t('taskSummaryDescription', { operation: translateCode(t, selected.kind, 'taskKind'), resource: selectedResource?.label || '—' })}</Typography.Paragraph></div><Progress percent={selected.progress} status={selected.status === 'failed' ? 'exception' : selected.status === 'succeeded' ? 'success' : undefined} /></div>
        {canOperate && continueTo && <Alert className="task-detail-alert" type={selected.status === 'succeeded' ? 'success' : selected.status === 'failed' ? 'warning' : 'info'} showIcon message={selected.status === 'succeeded' ? t('hostReadyContinue') : selected.status === 'failed' ? t('hostSetupFailedContinue') : t('hostSetupInProgress')} description={selected.status === 'succeeded' ? t('hostReadyContinueHint') : selected.status === 'failed' ? t('hostSetupFailedContinueHint') : t('hostSetupInProgressHint')} action={selected.status === 'succeeded' ? <Button size="small" type="primary" onClick={continueCreation}>{t('continueCreateDatabase')}</Button> : undefined} />}
        {selected.cancelAsked && <Alert className="task-detail-alert" type="warning" showIcon message={t('taskCancelPending')} />}
        {selected.errorMessage && <Alert className="task-detail-alert" type="error" showIcon message={t('taskFailureTitle', { stage: translateCode(t, selected.stage) })} description={<div className="task-error-detail"><Typography.Text>{taskSummary(selected)}</Typography.Text><Space size={6} wrap><Typography.Text type="secondary">{t('technicalDetails')}</Typography.Text>{selected.errorCode && <Tag color="red">{selected.errorCode}</Tag>}<Typography.Text code copyable>{selected.errorMessage}</Typography.Text></Space></div>} />}
        {selectedRecoveryHost && <Alert className="task-detail-alert task-recovery-alert" type="warning" showIcon message={t('taskRecoveryHostTitle')} description={t('taskRecoverySshTimeoutHint', { host: selectedRecoveryHost.name })} action={<Button size="small" icon={<CloudServerOutlined />} onClick={inspectRecoveryHost}>{t('inspectFailedHost')}</Button>} />}
        <Descriptions className="task-detail-meta" bordered size="small" column={2} items={[
          { key: 'resource', label: t('resource'), children: selectedResource?.path ? <Button type="link" icon={selectedResource.icon} onClick={() => goToResource(selected)}>{selectedResource.label}</Button> : selectedResource?.label || '—' },
          { key: 'attempts', label: t('attempts'), children: selected.attempts },
          { key: 'created', label: t('createdAt'), children: formatDateTime(selected.createdAt, i18n.language, timezone) },
          { key: 'started', label: t('startedAt'), children: formatDateTime(selected.startedAt, i18n.language, timezone) },
          { key: 'finished', label: t('finishedAt'), children: formatDateTime(selected.finishedAt, i18n.language, timezone) },
          { key: 'duration', label: t('duration'), children: duration(selected) },
        ]} />
        <Card className="task-log-card" size="small" title={t('executionLog')}>
          {logs.length ? <Timeline items={logs.map((log) => ({ color: log.level === 'error' ? 'red' : log.level === 'warning' ? 'orange' : selected.status === 'succeeded' ? 'green' : 'blue', children: <div className="task-log-entry"><Typography.Text type="secondary">{formatDateTime(log.createdAt, i18n.language, timezone)}</Typography.Text><Typography.Text>{translateCode(t, log.message, 'taskMessage')}</Typography.Text></div> }))} /> : <EmptyState compact description={t('noTaskLogs')} />}
        </Card>
      </div>}
    </Drawer>
  </>
}
