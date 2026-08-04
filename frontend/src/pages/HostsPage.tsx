import { ArrowRightOutlined, CloudServerOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, SafetyCertificateOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Drawer, Form, Grid, Input, InputNumber, Modal, Progress, Select, Space, Steps, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { TaskRetryRequestRecovery } from '../components/TaskRetryRequestRecovery'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { deploymentContinuationRequirement, deploymentReturnPathForHost, hostMeetsDeploymentRequirement, safeCreateReturnPath } from '../lib/deployment-continuation'
import { reservationForHost } from '../lib/host-capacity'
import { hostConnectionReady, hostPortPoolInvalid } from '../lib/host-verification'
import { mvpHostPayload } from '../lib/mvp-host'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { hostTaskRecoveryPhase, taskRecoveryConfirmationPath, taskRecoveryHostID, taskRecoveryInstanceID, taskRecoveryResourcePath } from '../lib/task-recovery'
import { selectRecoveryTasks } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import { useTaskRetryRequest } from '../lib/use-task-retry-request'
import type { DatabaseTemplate, Host, Instance, Task } from '../lib/types'
import { bytes } from '../lib/types'

interface HostForm {
  name: string; sshAddress: string; sshPort: number; sshUser: string; authType: string;
  credential?: string; passphrase?: string; connectionAddress?: string; dataRoot: string;
  portStart: number; portEnd: number;
}

interface HostProbeResult {
  hostKey: string; os: string; distro: string; architecture: string; dockerVersion: string; composeVersion: string;
  cpuCount: number; memoryBytes: number; diskTotalBytes: number; diskFreeBytes: number;
  dataRootWritable: boolean; portProbeAvailable: boolean; firstAvailablePort: number;
  verificationToken: string; verificationExpiresAt: string;
}

const verificationFields = new Set(['sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'dataRoot', 'portStart', 'portEnd'])
const hostDraftFields: Array<keyof HostForm> = ['name', 'sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'connectionAddress', 'dataRoot', 'portStart', 'portEnd']
const hostStatuses = ['pending', 'online', 'offline', 'degraded', 'needs_docker', 'unsupported']

function sameHostField(values: HostForm, baseline: HostForm, key: keyof HostForm) {
  const current = values[key]
  const original = baseline[key]
  if (typeof current === 'boolean' || typeof original === 'boolean') return !!current === !!original
  return (current ?? '') === (original ?? '')
}

function hostDraftChanged(values: HostForm, baseline: HostForm | null) {
  return !baseline || hostDraftFields.some((key) => !sameHostField(values, baseline, key))
}

function percent(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.round(used * 100 / limit)) : 0
}

export function HostsPage() {
  const { t, i18n } = useTranslation(); const { timezone } = useSystemSettings(); const { message, modal } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const hostID = params.get('host'); const recoveryTaskID = params.get('recoveryTask'); const returnTo = safeCreateReturnPath(params.get('returnTo')); const [items, setItems] = useState<Host[]>([]); const [instances, setInstances] = useState<Instance[]>([]); const [templates, setTemplates] = useState<DatabaseTemplate[]>([]); const [hostTasks, setHostTasks] = useState<Task[]>([]); const [loadError, setLoadError] = useState(''); const [supportingDataError, setSupportingDataError] = useState(''); const [continuationDataReady, setContinuationDataReady] = useState(false); const [detailError, setDetailError] = useState(''); const [hostContextState, setHostContextState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle'); const [verificationError, setVerificationError] = useState(''); const [saveError, setSaveError] = useState(''); const [open, setOpen] = useState(false); const [detail, setDetail] = useState<Host | null>(null); const [editing, setEditing] = useState<Host | null>(null); const [editorDirty, setEditorDirty] = useState(false); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [actioning, setActioning] = useState(''); const [fingerprint, setFingerprint] = useState(''); const [verificationToken, setVerificationToken] = useState(''); const [probe, setProbe] = useState<HostProbeResult | null>(null); const [verificationDirty, setVerificationDirty] = useState(false); const [search, setSearch] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [deleteTarget, setDeleteTarget] = useState<Host | null>(null); const [deleteConfirm, setDeleteConfirm] = useState(''); const [deleteError, setDeleteError] = useState(''); const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false); const [deleteRefreshing, setDeleteRefreshing] = useState(false); const [deleting, setDeleting] = useState(false); const [recoveryTask, setRecoveryTask] = useState<Task>(); const [recoveryTaskLoading, setRecoveryTaskLoading] = useState(false); const [recoveryTaskError, setRecoveryTaskError] = useState(''); const verificationSection = useRef<HTMLDivElement>(null); const hostBaseline = useRef<HostForm | null>(null); const [form] = Form.useForm<HostForm>()
  const { user } = useAuth(); const { canOperate } = permissionsFor(user!)
  const taskRetry = useTaskRetryRequest()
  const screens = Grid.useBreakpoint()
  const hostConnectionValues = Form.useWatch([], { form, preserve: true })
  const verificationRequired = !editing || verificationDirty
  const verificationReady = (!verificationRequired && !probe) || (!!fingerprint && !!verificationToken)
  const portPoolInvalid = hostPortPoolInvalid(hostConnectionValues)
  const connectionTestReady = hostConnectionReady(hostConnectionValues, !editing || verificationDirty)
  useEffect(() => {
    if (!probe && !verificationDirty && !verificationError) return
    const revealVerification = () => verificationSection.current?.scrollIntoView({ block: 'nearest' })
    const frame = window.requestAnimationFrame(revealVerification)
    const timer = window.setTimeout(revealVerification, 250)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [probe, verificationDirty, verificationError])
  const load = useCallback(async (): Promise<Host[] | undefined> => {
    try {
      const hosts = await api<{ items: Host[] }>('/hosts')
      setItems(hosts.items)
      setLoadError('')
      const [instanceList, templateList] = await Promise.allSettled([
        api<{ items: Instance[] }>('/instances'),
        returnTo ? api<{ items: DatabaseTemplate[] }>('/templates') : Promise.resolve({ items: [] }),
      ])
      if (instanceList.status === 'fulfilled') setInstances(instanceList.value.items)
      if (templateList.status === 'fulfilled') setTemplates(templateList.value.items)
      setContinuationDataReady(instanceList.status === 'fulfilled' && (!returnTo || templateList.status === 'fulfilled'))
      const failed = [instanceList, templateList].find((result) => result.status === 'rejected')
      setSupportingDataError(failed?.status === 'rejected' ? errorMessage(failed.reason) : '')
      return hosts.items
    } catch (error) { setLoadError(errorMessage(error)); return undefined } finally { setLoading(false) }
  }, [returnTo])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => clearInterval(timer) }, [load])
  useEffect(() => { if (!hostID || open) return; const linked = items.find((item) => item.id === hostID); if (linked) setDetail(linked) }, [hostID, items, open])
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return items.filter((item) => {
      if (statusFilter && item.status !== statusFilter) return false
      if (!needle) return true
      return `${item.name} ${item.sshAddress} ${item.sshUser} ${item.connectionAddress}`.toLocaleLowerCase().includes(needle)
    })
  }, [items, search, statusFilter])
  const hasHostFilters = !!(statusFilter || search.trim())
  const clearHostFilters = () => {
    setSearch('')
    setStatusFilter('')
  }
  const loadHostContext = useCallback(async (id: string, foreground = false): Promise<boolean> => {
    if (foreground) setHostContextState('loading')
    try {
      const [instanceList, taskList] = await Promise.all([api<{ items: Instance[] }>(`/instances?hostId=${encodeURIComponent(id)}`), api<{ items: Task[] }>(`/tasks?resourceType=host&resourceId=${encodeURIComponent(id)}`)])
      setInstances((current) => [...current.filter((instance) => instance.hostId !== id), ...instanceList.items])
      setHostTasks(taskList.items)
      setDetailError('')
      setHostContextState('ready')
      return true
    } catch (error) { setDetailError(errorMessage(error)); setHostContextState('error'); return false }
  }, [])
  useEffect(() => { if (!detail?.id) { setHostTasks([]); setDetailError(''); setHostContextState('idle'); return }; void loadHostContext(detail.id, true); const timer = window.setInterval(() => void loadHostContext(detail.id), 5000); return () => clearInterval(timer) }, [detail?.id, loadHostContext])
  const loadRecoveryTask = useCallback(async (id: string, foreground = false) => {
    if (foreground) setRecoveryTaskLoading(true)
    try {
      setRecoveryTask(await api<Task>(`/tasks/${encodeURIComponent(id)}`))
      setRecoveryTaskError('')
    } catch (error) {
      setRecoveryTaskError(errorMessage(error))
    } finally {
      if (foreground) setRecoveryTaskLoading(false)
    }
  }, [])
  useEffect(() => {
    if (!recoveryTaskID) {
      setRecoveryTask(undefined)
      setRecoveryTaskError('')
      setRecoveryTaskLoading(false)
      return
    }
    setRecoveryTask(undefined)
    void loadRecoveryTask(recoveryTaskID, true)
    const timer = window.setInterval(() => void loadRecoveryTask(recoveryTaskID), 3000)
    return () => window.clearInterval(timer)
  }, [loadRecoveryTask, recoveryTaskID])
  const show = (item?: Host) => {
    const values = (item
      ? { name: item.name, sshAddress: item.sshAddress, sshPort: item.sshPort, sshUser: item.sshUser, authType: item.authType, credential: '', passphrase: '', connectionAddress: item.connectionAddress, dataRoot: item.dataRoot, portStart: item.portStart, portEnd: item.portEnd }
      : { name: '', sshAddress: '', sshPort: 22, sshUser: '', authType: 'private_key', credential: '', passphrase: '', connectionAddress: '', dataRoot: '/opt/dbmock', portStart: 20000, portEnd: 40000 }) as HostForm
    if (item) setDetail(null)
    form.resetFields()
    setEditing(item ?? null)
    setEditorDirty(false)
    setVerificationError('')
    setSaveError('')
    setFingerprint(item?.hostKey ?? '')
    setVerificationToken('')
    setProbe(null)
    setVerificationDirty(false)
    hostBaseline.current = values
    form.setFieldsValue(values)
    setOpen(true)
  }
  useEffect(() => { if (params.get('create') === '1') { if (canOperate) show(); const next = new URLSearchParams(params); next.delete('create'); if (!canOperate) next.delete('returnTo'); setParams(next, { replace: true }) } }, [canOperate, params, setParams])
  const test = async () => {
    try {
      setVerificationError('')
      const values = await form.validateFields(['sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'dataRoot', 'portStart', 'portEnd'])
      setTesting(true)
      setFingerprint('')
      setVerificationToken('')
      setProbe(null)
      const result = await api<HostProbeResult>('/hosts/test', { method: 'POST', body: { ...values, hostId: editing?.id } })
      setFingerprint(result.hostKey)
      setVerificationToken(result.verificationToken)
      setProbe(result)
      setVerificationDirty(false)
      if (returnTo && !editing && continuationRequirement.status === 'resolved' && !hostMeetsDeploymentRequirement(result, continuationRequirement)) {
        message.warning(t('deploymentHostArchitectureMismatch', { architecture: result.architecture, architectures: continuationRequirement.architectures.join(' / ') }))
      } else {
        message.success(t('connectionVerified'))
      }
    } catch (error) {
      if (error instanceof Error) setVerificationError(errorMessage(error))
    } finally {
      setTesting(false)
    }
  }
  const submit = async () => {
    try {
      setSaveError('')
      setSaving(true)
      const values = await form.validateFields()
      if (!verificationReady) { message.warning(t('confirmFingerprint')); return }
      if (continuationSaveBlocked) {
        message.warning(t('databaseCreationContextUnavailable'))
        return
      }
      if (probeIncompatible) {
        message.warning(t('deploymentHostArchitectureMismatch', { architecture: probe?.architecture || '—', architectures: continuationRequirement.architectures.join(' / ') }))
        return
      }
      const result = await api<Host | { host: Host; task: Task }>(editing ? `/hosts/${editing.id}` : '/hosts', { method: editing ? 'PUT' : 'POST', body: { ...mvpHostPayload(values), verificationToken } })
      setEditorDirty(false)
      if ('task' in result) {
        notifyTask(result.task)
        setOpen(false)
        const continueTo = deploymentReturnPathForHost(returnTo, result.host.id)
        if (continueTo) { navigate(`/tasks?task=${result.task.id}&continue=${encodeURIComponent(continueTo)}`); return }
      } else {
        message.success(t('saved'))
        if (returnTo && result.status === 'online') {
          setOpen(false)
          navigate(deploymentReturnPathForHost(returnTo, result.id))
          return
        }
      }
      setOpen(false)
      await load()
    } catch (error) {
      if (error instanceof Error) setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }
  const action = async (item: Host, actionName: string) => {
    try {
      setActioning(actionName)
      const task = await api<Task>(`/hosts/${item.id}/actions/${actionName}`, { method: 'POST', body: {} })
      setHostTasks((current) => [task, ...current])
      notifyTask(task)
      await Promise.all([load(), loadHostContext(item.id)])
    } catch (e) { message.error(errorMessage(e)) } finally { setActioning('') }
  }
  const invalidateVerification = (changed: Partial<HostForm>, values: HostForm) => {
    setEditorDirty(hostDraftChanged(values, hostBaseline.current))
    setVerificationError('')
    setSaveError('')
    const changedKeys = Object.keys(changed)
    const connectionChanged = changedKeys.some((key) => verificationFields.has(key))
    const baseline = hostBaseline.current
    const connectionMatchesBaseline = !!baseline && [...verificationFields].every((key) => sameHostField(values, baseline, key as keyof HostForm))
    if (editing && connectionMatchesBaseline && connectionChanged) {
      setFingerprint(editing.hostKey ?? ''); setVerificationToken(''); setProbe(null); setVerificationDirty(false)
      return
    }
    if (!connectionChanged) return
    if (!fingerprint && !verificationDirty) return
    setFingerprint(''); setVerificationToken(''); setProbe(null); setVerificationDirty(true)
  }
  const openDetail = (item: Host) => { const next = new URLSearchParams(params); next.set('host', item.id); if (item.id !== hostID) next.delete('recoveryTask'); setParams(next, { replace: true }); setDetail(item) }
  const closeDetail = () => { setDetail(null); if (hostID || recoveryTaskID) { const next = new URLSearchParams(params); next.delete('host'); next.delete('recoveryTask'); setParams(next, { replace: true }) } }
  const finishCloseEditor = () => { setOpen(false); setEditorDirty(false); setVerificationError(''); setSaveError(''); hostBaseline.current = null; if (editing && hostID) setDetail(items.find((item) => item.id === hostID) ?? editing) }
  const closeEditor = () => {
    if (saving || testing) return
    if (!editorDirty) { finishCloseEditor(); return }
    modal.confirm({
      title: t('discardHostChangesTitle'),
      content: t('discardHostChangesHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseEditor,
    })
  }
  const cancelDatabaseCreation = () => { setOpen(false); navigate('/instances') }
  const showDelete = (item: Host) => {
    setDeleteTarget(item)
    setDeleteConfirm('')
    setDeleteError('')
    setDeleteNeedsRefresh(false)
  }
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteConfirm('')
    setDeleteError('')
    setDeleteNeedsRefresh(false)
  }
  const remove = async () => {
    if (!deleteTarget || deleteConfirm !== deleteTarget.name || deleteNeedsRefresh || hostContextState !== 'ready') return
    try {
      setDeleting(true)
      setDeleteError('')
      await api(`/hosts/${deleteTarget.id}`, { method: 'DELETE', body: { confirmName: deleteConfirm } })
      message.success(t('deleted'))
      closeDetail()
      setDeleteTarget(null)
      setDeleteConfirm('')
      await load()
    } catch (error) {
      setDeleteError(errorMessage(error))
      setDeleteConfirm('')
      setDeleteNeedsRefresh(true)
    } finally {
      setDeleting(false)
    }
  }
  const refreshDeleteEvidence = async () => {
    if (!deleteTarget) return
    try {
      setDeleteRefreshing(true)
      const hosts = await load()
      if (!hosts) return
      if (!hosts.some((host) => host.id === deleteTarget.id)) {
        message.success(t('hostDeleteAlreadyCompleted'))
        closeDetail()
        setDeleteTarget(null)
        setDeleteError('')
        setDeleteNeedsRefresh(false)
        return
      }
      const contextReady = await loadHostContext(deleteTarget.id, true)
      if (!contextReady) return
      setDeleteNeedsRefresh(false)
      setDeleteError('')
    } finally {
      setDeleteRefreshing(false)
    }
  }
  const relatedInstances = detail ? instances.filter((instance) => instance.hostId === detail.id) : []
  const schedulableHosts = items.filter((item) => item.status === 'online')
  const continuationRequirement = useMemo(
    () => deploymentContinuationRequirement(returnTo, templates),
    [returnTo, templates],
  )
  const continuationContextReady = !!returnTo && !loading && !loadError && continuationDataReady
  const compatibleReadyHosts = continuationContextReady
    ? schedulableHosts.filter((host) => hostMeetsDeploymentRequirement(host, continuationRequirement))
    : []
  const continuationHost = compatibleReadyHosts.length === 1 ? compatibleReadyHosts[0] : undefined
  const continuationPath = deploymentReturnPathForHost(returnTo, continuationHost?.id)
  const continuationState = loading
    ? 'loading'
    : !continuationContextReady || continuationRequirement.status === 'unresolved'
      ? 'unavailable'
      : compatibleReadyHosts.length > 0
        ? 'ready'
        : continuationRequirement.status === 'resolved' && schedulableHosts.length > 0
          ? 'incompatible'
          : 'pending'
  const continuationTemplateName = continuationRequirement.status === 'resolved'
    ? i18n.language.startsWith('zh') ? continuationRequirement.templateNameZh || continuationRequirement.templateName : continuationRequirement.templateName
    : ''
  const continuationArchitectures = continuationRequirement.architectures.join(' / ')
  const probeIncompatible = !!returnTo && !editing && !!probe && continuationRequirement.status === 'resolved' && !hostMeetsDeploymentRequirement(probe, continuationRequirement)
  const continuationSaveBlocked = !!returnTo && !editing && ['loading', 'unavailable'].includes(continuationState)
  const detailReservation = detail ? reservationForHost(instances, detail.id) : { cpu: 0, memory: 0, disk: 0, ports: [] }
  const { activeTask, failedTask, operationTask } = selectRecoveryTasks(hostTasks, Boolean(detail && ['offline', 'needs_docker', 'unsupported'].includes(detail.status)))
  const applyAcceptedRetry = (retried: Task, preserveRecovery: boolean) => {
    setHostTasks((current) => [retried, ...current.filter((task) => task.id !== retried.id)])
    notifyTask(retried)
    if (!preserveRecovery || !detail) return
    setRecoveryTask(retried)
    const next = new URLSearchParams(params)
    next.set('host', detail.id)
    next.set('recoveryTask', retried.id)
    setParams(next, { replace: true })
  }
  const submitTaskRetry = async (task: Task, preserveRecovery: boolean, actionKey: string) => {
    if (!detail) return
    try {
      setActioning(actionKey)
      const retried = await taskRetry.request(task)
      if (retried) applyAcceptedRetry(retried, preserveRecovery)
      await Promise.all([load(), loadHostContext(detail.id)])
    } finally {
      setActioning('')
    }
  }
  const retryTask = async () => {
    if (failedTask) await submitTaskRetry(failedTask, false, 'retry-task')
  }
  const retryRecoveryTask = async () => {
    if (recoveryTask) await submitTaskRetry(recoveryTask, true, 'retry-recovery-task')
  }
  const refreshTaskRetryEvidence = async () => {
    const retried = await taskRetry.refresh()
    if (retried) applyAcceptedRetry(retried, Boolean(recoveryTaskID))
    if (detail) {
      await Promise.all([load(), loadHostContext(detail.id)])
    }
  }
  const columns = useMemo(() => [
    { title: t('name'), dataIndex: 'name', width: 170, render: (value: string, item: Host) => <Button type="link" className="description-link" onClick={() => openDetail(item)}><CloudServerOutlined /> {value}</Button> },
    { title: t('status'), dataIndex: 'status', width: 90, render: (value: string) => <StatusTag value={value} /> },
    { title: t('ssh'), width: 200, render: (_: unknown, item: Host) => <><Typography.Text>{item.sshUser}@{item.sshAddress}:{item.sshPort}</Typography.Text><br /><Typography.Text type="secondary">{item.distro || item.os || '—'} / {item.architecture || '—'}</Typography.Text></> },
    { title: t('docker'), width: 130, render: (_: unknown, item: Host) => <><Typography.Text>{item.dockerVersion || t('dockerNotInstalled')}</Typography.Text><br /><Typography.Text type="secondary">{t('compose')} {item.composeVersion || '—'}</Typography.Text></> },
    ...(screens.xl ? [{ title: t('schedulingCapacity'), width: 240, render: (_: unknown, item: Host) => { const related = instances.filter((instance) => instance.hostId === item.id); const reserved = reservationForHost(instances, item.id); return <div className="host-list-capacity"><div><DatabaseOutlined /><Typography.Text>{t('managedInstanceCount', { count: related.length })}</Typography.Text></div><Typography.Text type="secondary">{t('reservedCapacity')}: {reserved.cpu} CPU · {bytes(reserved.memory)} · {bytes(reserved.disk)}</Typography.Text></div> } }] : []),
    { title: t('actions'), width: 84, align: 'right' as const, render: (_: unknown, item: Host) => canOperate ? <Space size={4}><Button type="text" aria-label={`${t('reprobeHost')} ${item.name}`} title={t('reprobeHost')} icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!actioning && actioning !== 'probe'} onClick={() => void action(item, 'probe')} /><Button type="text" aria-label={`${t('edit')} ${item.name}`} title={t('edit')} icon={<EditOutlined />} disabled={!!actioning} onClick={() => show(item)} /></Space> : null },
  ], [actioning, canOperate, instances, screens.xl, t])
  const capacityItems = detail ? [
    { key: 'cpu', label: t('cpu'), reserved: detailReservation.cpu, limit: detail.cpuCount * .9, format: (value: number) => `${value.toFixed(value % 1 ? 1 : 0)} CPU` },
    { key: 'memory', label: t('memory'), reserved: detailReservation.memory, limit: detail.memoryBytes * .8, format: bytes },
    { key: 'disk', label: t('disk'), reserved: detailReservation.disk, limit: detail.diskFreeBytes * .8, format: bytes },
  ] : []
  const operationPanel = operationTask && <div className={`instance-operation host-operation is-${activeTask ? 'active' : 'failed'}`}>
    <div className="instance-operation-copy"><Space wrap><StatusTag value={operationTask.status} /><Typography.Text strong>{translateCode(t, operationTask.kind, 'taskKind')}</Typography.Text><Typography.Text type="secondary">· {translateCode(t, operationTask.stage, 'taskStage')}</Typography.Text></Space><Typography.Paragraph type={activeTask ? 'secondary' : 'danger'}>{activeTask ? translateCode(t, operationTask.message, 'taskMessage') : operationTask.errorCode && operationTask.errorCode !== 'task_failed' ? translateCode(t, operationTask.errorCode, 'taskError') : operationTask.errorMessage || translateCode(t, operationTask.message, 'taskMessage')}</Typography.Paragraph></div>
    {activeTask && <Progress className="instance-operation-progress" percent={operationTask.progress} status="active" size="small" />}
    <Space className="instance-operation-actions">{recoveryTaskID
      ? <Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewHostCheckTask')}</Button>
      : <>{canOperate && failedTask && !activeTask && taskRetry.failure?.taskId !== failedTask.id && <Button type="primary" icon={<ReloadOutlined />} loading={actioning === 'retry-task'} disabled={!!actioning && actioning !== 'retry-task'} onClick={() => void retryTask()}>{t('retryTask')}</Button>}<Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewTask')}</Button></>}</Space>
  </div>
  const recoveryPhase = detail && recoveryTask ? hostTaskRecoveryPhase(recoveryTask, detail, Boolean(activeTask)) : undefined
  const recoveryResourcePath = recoveryPhase === 'succeeded'
    ? taskRecoveryConfirmationPath(recoveryTask) || taskRecoveryResourcePath(recoveryTask)
    : taskRecoveryResourcePath(recoveryTask)
  const recoveryInstanceID = taskRecoveryInstanceID(recoveryTask)
  const recoveryResourceName = recoveryInstanceID
    ? instances.find((instance) => instance.id === recoveryInstanceID)?.name || recoveryInstanceID
    : recoveryTask?.resourceId
  const recoveryTitleKey = recoveryTaskLoading && !recoveryTask
    ? 'hostRecoveryLoadingTitle'
    : recoveryTaskError && !recoveryTask
      ? 'hostRecoveryLoadFailedTitle'
      : recoveryPhase
        ? `hostRecoveryTitle_${recoveryPhase}`
        : 'hostRecoveryUnavailableTitle'
  const recoveryHintKey = recoveryTaskLoading && !recoveryTask
    ? 'hostRecoveryLoadingHint'
    : recoveryTaskError && !recoveryTask
      ? 'hostRecoveryLoadFailedHint'
      : recoveryPhase === 'needs_host' && activeTask
        ? 'hostRecoveryProbeActiveHint'
        : recoveryPhase === 'ready' && !canOperate
          ? 'hostRecoveryReadyReadOnlyHint'
          : recoveryPhase
            ? `hostRecoveryHint_${recoveryPhase}`
            : 'hostRecoveryUnavailableHint'
  const recoveryPanelType = recoveryPhase === 'ready' || recoveryPhase === 'succeeded'
      ? 'success'
      : recoveryPhase === 'active' || (recoveryTaskLoading && !recoveryTask)
        ? 'info'
        : 'warning'
  const recoveryTaskTarget = recoveryTask?.id || recoveryTaskID
  const recoveryPanel = recoveryTaskID && detail && <Alert
    className="host-recovery-alert"
    type={recoveryPanelType}
    showIcon
    message={t(recoveryTitleKey)}
    description={<div className="host-recovery-content" data-recovery-phase={recoveryPhase || 'loading'}>
      {recoveryTask && <div className="host-recovery-context">
        <div>
          <Typography.Text type="secondary">{t('hostRecoveryOriginalOperation')}</Typography.Text>
          <Typography.Text strong>{translateCode(t, recoveryTask.kind, 'taskKind')}</Typography.Text>
        </div>
        <div>
          <Typography.Text type="secondary">{t('resource')}</Typography.Text>
          <Typography.Text strong>{recoveryResourceName || t('resourceUnavailable')}</Typography.Text>
        </div>
        <StatusTag value={recoveryTask.status} />
      </div>}
      <Typography.Paragraph className="host-recovery-hint" type="secondary">{t(recoveryHintKey)}</Typography.Paragraph>
      {recoveryTask && ['failed', 'canceled', 'interrupted'].includes(recoveryTask.status) && <Typography.Text className="host-recovery-error" type="danger">{t('hostRecoveryLastFailure')}: {recoveryTask.errorCode ? translateCode(t, recoveryTask.errorCode, 'taskError') : recoveryTask.errorMessage || translateCode(t, recoveryTask.message, 'taskMessage')}</Typography.Text>}
      {recoveryTaskError && recoveryTask && <Typography.Text className="host-recovery-error" type="danger" role="alert">{t('hostRecoveryRefreshFailed')}: {recoveryTaskError}</Typography.Text>}
      <Space className="host-recovery-actions" wrap>
        {canOperate && recoveryPhase === 'needs_host' && <Button type="primary" icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!activeTask || (!!actioning && actioning !== 'probe')} onClick={() => void action(detail, 'probe')}>{t('reprobeHost')}</Button>}
        {canOperate && recoveryPhase === 'ready' && taskRetry.failure?.taskId !== recoveryTask?.id && <Button type="primary" icon={<RedoOutlined />} loading={actioning === 'retry-recovery-task'} disabled={!!actioning && actioning !== 'retry-recovery-task'} onClick={() => void retryRecoveryTask()}>{t('retryOriginalTask')}</Button>}
        {recoveryPhase === 'succeeded' && recoveryResourcePath && <Button type="primary" icon={<ArrowRightOutlined />} onClick={() => navigate(recoveryResourcePath)}>{t('returnToConfirmStatus')}</Button>}
        {recoveryTaskTarget && <Button onClick={() => navigate(`/tasks?task=${encodeURIComponent(recoveryTaskTarget)}`)}>{t('viewTask')}</Button>}
        {recoveryResourcePath && recoveryPhase !== 'succeeded' && <Button icon={<ArrowRightOutlined />} onClick={() => navigate(recoveryResourcePath)}>{t('returnToFailedResource')}</Button>}
        {recoveryTaskError && <Button loading={recoveryTaskLoading} onClick={() => void loadRecoveryTask(recoveryTaskID, true)}>{t('retry')}</Button>}
      </Space>
    </div>}
  />
  const taskRetryHostID = taskRecoveryHostID(taskRetry.evidence?.original)
  const taskRetryRequestPanel = taskRetry.failure && taskRetry.evidence && <TaskRetryRequestRecovery
    className="host-task-retry-request-alert"
    failure={taskRetry.failure}
    evidence={taskRetry.evidence}
    refreshing={taskRetry.refreshing}
    refreshError={taskRetry.refreshError}
    submittingTaskID={taskRetry.submittingTaskID}
    showRetry={canOperate}
    onClose={taskRetry.clear}
    onRefresh={() => void refreshTaskRetryEvidence()}
    onRetry={(task) => void submitTaskRetry(task, task.id === recoveryTaskID, task.id === recoveryTaskID ? 'retry-recovery-task' : 'retry-task')}
    onOpenTask={(task) => navigate(`/tasks?task=${encodeURIComponent(task.id)}`)}
    onOpenResource={(task) => {
      const path = taskRecoveryResourcePath(task)
      if (path) navigate(path)
    }}
  />
  const continuationMessageKey = continuationState === 'loading'
    ? 'databaseCreationRequirementsLoading'
    : continuationState === 'unavailable'
      ? 'databaseCreationContextUnavailable'
      : continuationState === 'ready'
        ? continuationRequirement.status === 'resolved' ? 'databaseCreationCompatibleHostReady' : 'databaseCreationReadyHost'
        : continuationState === 'incompatible'
          ? 'databaseCreationIncompatibleHost'
          : continuationRequirement.status === 'resolved' ? 'databaseCreationCompatibleHostPending' : 'databaseCreationPending'
  const continuationHintKey = continuationState === 'loading'
    ? 'databaseCreationRequirementsLoadingHint'
    : continuationState === 'unavailable'
      ? 'databaseCreationContextUnavailableHint'
      : continuationState === 'ready'
        ? continuationRequirement.status === 'resolved' ? 'databaseCreationCompatibleHostReadyHint' : 'databaseCreationReadyHostHint'
        : continuationState === 'incompatible'
          ? 'databaseCreationIncompatibleHostHint'
          : continuationRequirement.status === 'resolved' ? 'databaseCreationRequiredHostHint' : 'databaseCreationHostHint'
  const continuationTextValues = {
    count: compatibleReadyHosts.length,
    onlineCount: schedulableHosts.length,
    database: continuationTemplateName,
    version: continuationRequirement.status === 'resolved' ? continuationRequirement.templateVersion : '',
    architectures: continuationArchitectures,
  }
  const creationProgress = <div className="host-continuation-copy"><Typography.Paragraph type="secondary">{t(continuationHintKey, continuationTextValues)}</Typography.Paragraph><Steps className="host-continuation-steps" current={continuationState === 'ready' ? 2 : continuationState === 'incompatible' ? 1 : 0} size="small" responsive={false} items={[{ title: t('hostSetupStepConnect') }, { title: t('hostSetupStepVerify') }, { title: t('hostSetupStepCreate') }]} /></div>
  return <><PageHeader title={t('hosts')} description={t('hostsDescription')} />
    {canOperate && returnTo && <Alert className="host-continuation-banner" type={continuationState === 'ready' ? 'success' : ['incompatible', 'unavailable'].includes(continuationState) ? 'warning' : 'info'} showIcon icon={<DatabaseOutlined />} message={t(continuationMessageKey)} description={creationProgress} action={<Space direction="vertical" size={4}>{continuationState === 'ready' && <Button type="primary" size="small" onClick={() => navigate(continuationPath)}>{t('continueCreateDatabase')}</Button>}{continuationState === 'loading' && <Button size="small" loading disabled>{t('loading')}</Button>}{continuationState === 'unavailable' && <Button type="primary" size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>}{['ready', 'incompatible', 'pending'].includes(continuationState) && <Button type={continuationState === 'ready' ? 'default' : 'primary'} size="small" onClick={() => show()}>{t(continuationRequirement.status === 'resolved' ? continuationState === 'ready' ? 'continueAddAnotherCompatibleHost' : 'continueAddCompatibleHost' : continuationState === 'ready' ? 'continueAddAnotherHost' : 'continueAddHost')}</Button>}<Button type="link" size="small" onClick={cancelDatabaseCreation}>{t('returnToCatalog')}</Button></Space>} />}
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('hostListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {supportingDataError && <Alert className="instance-page-alert" type="warning" showIcon message={t('hostSupportingDataLoadFailed')} description={supportingDataError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {taskRetryRequestPanel && (!detail || taskRetryHostID !== detail.id) && <div className="instance-page-alert">{taskRetryRequestPanel}</div>}
    {(items.length > 0 || !loadError) && <Card className="host-table-card"><div className="embedded-toolbar host-toolbar"><div className="host-list-heading"><Typography.Text strong>{t('hosts')}</Typography.Text><Typography.Text type="secondary">{t(hasHostFilters ? 'hostFilteredResultCount' : 'hostResultCount', { filtered: filteredItems.length, total: items.length, count: items.length })}</Typography.Text></div><Space wrap className="host-filter-controls"><Input allowClear className="host-search" aria-label={t('hostSearchLabel')} placeholder={t('hostSearchPlaceholder')} prefix={<SearchOutlined />} value={search} onChange={(event) => setSearch(event.target.value)} /><Select className="host-status-filter" aria-label={t('status')} value={statusFilter} onChange={setStatusFilter} options={[{ value: '', label: t('allStatuses') }, ...hostStatuses.map((status) => ({ value: status, label: translateCode(t, status) }))]} /><Button loading={loading} icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>{canOperate && items.length > 0 && <Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('addHost')}</Button>}</Space></div><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} pagination={false} tableLayout="fixed" scroll={{ x: screens.xl ? 914 : 674 }} locale={{ emptyText: <EmptyState compact action={hasHostFilters ? clearHostFilters : canOperate ? () => show() : undefined} actionLabel={hasHostFilters ? t('clearFilters') : canOperate ? t('addHost') : undefined} description={t(hasHostFilters ? 'hostsFilteredEmptyDescription' : 'noHostsDescription')} /> }} /></Card>}
    <Modal className="host-editor-modal" title={editing ? t('editHost') : t('addHost')} open={open} onCancel={closeEditor} width={760} style={{ top: screens.md === false ? 12 : 32 }} styles={{ body: { maxHeight: screens.md === false ? 'calc(100dvh - 220px)' : 'calc(100vh - 160px)', overflowY: 'auto', paddingRight: 4 } }} destroyOnHidden footer={<div className="workflow-modal-footer"><Button disabled={saving || testing} onClick={closeEditor}>{t('cancel')}</Button><Space>{(!editing || verificationDirty || !fingerprint) && <Button loading={testing} disabled={saving || !connectionTestReady} icon={<SafetyCertificateOutlined />} onClick={() => void test()}>{t('testConnection')}</Button>}<Button type="primary" loading={saving} disabled={testing || !verificationReady || continuationSaveBlocked || probeIncompatible || (!!editing && !editorDirty)} onClick={() => void submit()}>{t('save')}</Button></Space></div>}>
      <Form form={form} className="host-editor-form" layout="vertical" requiredMark={false} autoComplete="off" onValuesChange={invalidateVerification}><Alert className="form-save-alert" type="info" showIcon message={t(editing ? 'hostEditFormHint' : 'hostCreateFormHint')} />{saveError && <Alert className="form-save-alert" type="error" showIcon message={t('hostSaveFailed')} description={saveError} />}{returnTo && !editing && <Alert className="host-continuation-modal-alert" type={['incompatible', 'unavailable'].includes(continuationState) ? 'warning' : 'info'} showIcon icon={<DatabaseOutlined />} message={t(continuationMessageKey)} description={creationProgress} />}<Typography.Text className="form-section-label">{t('connectionSettings')}</Typography.Text><div className="form-grid"><Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input autoFocus autoComplete="off" maxLength={120} placeholder={t('hostNamePlaceholder')} /></Form.Item><Form.Item name="sshAddress" label={t('sshAddress')} rules={[{ required: true, whitespace: true, max: 255 }]}><Input autoComplete="off" maxLength={255} placeholder={t('sshAddressPlaceholder')} /></Form.Item><Form.Item name="sshPort" label={t('sshPort')} rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="sshUser" label={t('sshUser')} rules={[{ required: true, whitespace: true, max: 255 }]}><Input autoComplete="off" maxLength={255} placeholder={t('sshUserPlaceholder')} data-1p-ignore data-lpignore="true" /></Form.Item><Form.Item name="authType" label={t('authentication')}><Select options={[{ value: 'private_key', label: t('privateKey') }, { value: 'password', label: t('password') }]} /></Form.Item></div>
        <Form.Item noStyle shouldUpdate={(a, b) => a.authType !== b.authType}>{({ getFieldValue }) => <><Form.Item name="credential" label={getFieldValue('authType') === 'password' ? t('password') : t('privateKey')} extra={t('hostCredentialHint')} rules={!editing || verificationDirty ? [{ required: true }] : []}>{getFieldValue('authType') === 'password' ? <Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /> : <Input.TextArea rows={4} autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={t('privateKeyPlaceholder')} />}</Form.Item>{getFieldValue('authType') === 'private_key' && <Form.Item name="passphrase" label={t('privateKeyPassphrase')}><Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>}</>}</Form.Item>
        <Typography.Text className="form-section-label">{t('hostDeploymentSettings')}</Typography.Text><Typography.Paragraph className="host-deployment-hint" type="secondary">{t('hostDeploymentSettingsHint')}</Typography.Paragraph><div className="form-grid"><Form.Item name="connectionAddress" label={t('databaseConnectionAddress')} rules={[{ max: 255 }]}><Input maxLength={255} placeholder={t('defaultsToSSHAddress')} /></Form.Item><Form.Item name="dataRoot" label={t('managedDataRoot')} rules={[{ required: true, whitespace: true, max: 4096 }]}><Input maxLength={4096} /></Form.Item><Form.Item name="portStart" label={t('portPoolStart')} rules={[{ required: true, type: 'number', min: 1, max: 65535 }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="portEnd" label={t('portPoolEnd')} dependencies={['portStart']} validateStatus={portPoolInvalid ? 'error' : undefined} help={portPoolInvalid ? t('portPoolRangeInvalid') : undefined} rules={[{ required: true, type: 'number', min: 1, max: 65535 },({ getFieldValue }) => ({ validator: (_, value) => value === undefined || value >= getFieldValue('portStart') ? Promise.resolve() : Promise.reject(new Error(t('portPoolRangeInvalid'))) })]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></div>
        {verificationRequired && <div ref={verificationSection} className="verification-section"><Typography.Text className="form-section-label">{t('connectionVerification')}</Typography.Text>{verificationError ? <Alert type="error" showIcon message={t('hostConnectionTestFailed')} description={<Space direction="vertical" size={2}><Typography.Text>{verificationError}</Typography.Text><Typography.Text type="secondary">{t('hostConnectionFailureHint')}</Typography.Text></Space>} /> : probe ? <><Alert type="success" showIcon message={t('connectionVerified')} description={<><Descriptions size="small" column={2} items={[{ key: 'system', label: t('testResultSystem'), children: `${probe.os}/${probe.architecture}` },{ key: 'docker', label: t('testResultDocker'), children: probe.dockerVersion ? `${probe.dockerVersion} / ${probe.composeVersion || '—'}` : t('dockerNotInstalled') },{ key: 'resources', label: t('testResultResources'), children: `${probe.cpuCount} CPU · ${bytes(probe.memoryBytes)} · ${bytes(probe.diskFreeBytes)}` },{ key: 'root', label: t('testResultDataRoot'), children: probe.dataRootWritable ? t('writable') : t('unavailable') },{ key: 'port', label: t('testResultPortPool'), children: probe.portProbeAvailable ? probe.firstAvailablePort ? t('firstAvailablePort', { port: probe.firstAvailablePort }) : t('portPoolExhausted') : t('unavailable') }]} /><Typography.Text code copyable className="fingerprint-value">{fingerprint.split(' ')[0]}</Typography.Text></>} />{probeIncompatible && <Alert type="warning" showIcon message={t('deploymentHostArchitectureMismatch', { architecture: probe.architecture, architectures: continuationArchitectures })} description={t('deploymentHostArchitectureMismatchHint', { database: continuationTemplateName, version: continuationRequirement.status === 'resolved' ? continuationRequirement.templateVersion : '', architecture: probe.architecture, architectures: continuationArchitectures })} />}{probe.portProbeAvailable && !probe.firstAvailablePort && <Alert type="warning" showIcon message={t('portPoolExhausted')} description={t('portPoolExhaustedHint')} />}</> : <Alert type={verificationDirty ? 'warning' : 'info'} showIcon message={verificationDirty ? t('connectionChanged') : t(portPoolInvalid ? 'portPoolRangeInvalid' : connectionTestReady ? 'connectionVerificationHint' : 'connectionDetailsIncomplete')} />}</div>}
      </Form>
    </Modal>
    <Drawer className="host-detail-drawer" title={detail ? <div className="host-detail-title"><div><CloudServerOutlined /><Typography.Text strong>{detail.name}</Typography.Text></div><StatusTag value={detail.status} /></div> : t('hostDetails')} open={!!detail} onClose={closeDetail} width={780} destroyOnHidden footer={canOperate && detail ? <div className="workflow-drawer-footer"><Button danger icon={<DeleteOutlined />} disabled={hostContextState !== 'ready' || relatedInstances.length > 0 || !!activeTask || !!actioning} title={hostContextState !== 'ready' ? t('hostDeleteEvidenceUnavailable') : relatedInstances.length ? t('hostDeleteBlocked') : activeTask ? t('hostOperationInProgress') : t('delete')} onClick={() => showDelete(detail)}>{t('delete')}</Button><Space wrap>{!recoveryTaskID && <Button icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!activeTask || (!!actioning && actioning !== 'probe')} onClick={() => void action(detail, 'probe')}>{t('reprobeHost')}</Button>}<Button icon={<EditOutlined />} disabled={!!activeTask || !!actioning} onClick={() => show(detail)}>{t('edit')}</Button></Space></div> : undefined}>
      {detail && <div className="host-detail">
        {detailError && <Alert type="warning" showIcon message={t('hostContextLoadFailed')} description={detailError} action={<Button size="small" onClick={() => void loadHostContext(detail.id)}>{t('retry')}</Button>} />}
        {recoveryPanel}
        {taskRetryHostID === detail.id && taskRetryRequestPanel}
        {operationPanel}
        <div className={`host-health-banner is-${detail.status === 'online' ? 'success' : detail.status === 'needs_docker' ? 'warning' : 'error'}`}>
          <div><StatusTag value={detail.status} /><Typography.Text strong>{t('currentHostState')}</Typography.Text></div>
          <Typography.Paragraph>{detail.statusMessage ? translateCode(t, detail.statusMessage, 'statusMessage') : detail.status === 'online' ? t('hostOnlineHint') : detail.status === 'needs_docker' ? t('hostNeedsDockerHint') : t('hostOfflineHint')}</Typography.Paragraph>
          {canOperate && detail.status === 'needs_docker' && <div className="host-health-guidance"><Typography.Text>{t('hostNeedsDockerManualHint')}</Typography.Text><Button size="small" type="primary" icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!activeTask || (!!actioning && actioning !== 'probe')} onClick={() => void action(detail, 'probe')}>{t('reprobeHost')}</Button></div>}
          <div className="host-health-facts"><span><Typography.Text type="secondary">{t('lastChecked')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastCheckedAt, i18n.language, timezone)}</Typography.Text></span><span><Typography.Text type="secondary">{t('lastSeen')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastSeenAt, i18n.language, timezone)}</Typography.Text></span><span><Typography.Text type="secondary">{t('consecutiveFailures')}</Typography.Text><Typography.Text>{detail.consecutiveFailures}</Typography.Text></span></div>
        </div>
        <Card size="small" title={t('schedulingCapacity')} extra={<Typography.Text type="secondary">{t('schedulingCapacityPolicy')}</Typography.Text>}><div className="host-capacity-grid">{capacityItems.map((item) => <div className="host-capacity-item" key={item.key}><div><Typography.Text strong>{item.label}</Typography.Text><Typography.Text type="secondary">{t('capacityRemaining', { value: item.format(Math.max(0, item.limit - item.reserved)) })}</Typography.Text></div><Progress percent={percent(item.reserved, item.limit)} size="small" status={item.reserved > item.limit ? 'exception' : 'normal'} /><Typography.Text type="secondary">{t('capacityReservedOf', { reserved: item.format(item.reserved), limit: item.format(item.limit) })}</Typography.Text></div>)}</div></Card>
        <Card size="small" title={t('managedInstances')} extra={<Typography.Text type="secondary">{t('managedInstanceCount', { count: relatedInstances.length })}</Typography.Text>} className="host-instance-card"><Table size="small" rowKey="id" pagination={false} dataSource={relatedInstances} locale={{ emptyText: <EmptyState compact description={t('noManagedInstances')} /> }} columns={[{ title: t('name'), dataIndex: 'name', render: (value: string, instance: Instance) => <Button type="link" className="description-link" onClick={() => navigate(`/instances/${instance.id}`)}>{value}</Button> },{ title: t('status'), dataIndex: 'status', width: 110, render: (value: string) => <StatusTag value={value} /> },{ title: t('resources'), width: 190, render: (_: unknown, instance: Instance) => `${instance.cpu} CPU · ${bytes(instance.memoryBytes)} · ${bytes(instance.reservedDiskBytes)}` },{ title: t('port'), dataIndex: 'hostPort', width: 85 }]} /></Card>
        <Card size="small" title={t('hostConfiguration')}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'ssh', label: t('ssh'), children: `${detail.sshUser}@${detail.sshAddress}:${detail.sshPort}` },{ key: 'connect', label: t('databaseAddress'), children: detail.connectionAddress || detail.sshAddress },{ key: 'system', label: t('system'), children: `${detail.distro || detail.os || '—'} / ${detail.architecture || '—'}` },{ key: 'docker', label: t('docker'), children: detail.dockerVersion || t('dockerNotInstalled') },{ key: 'compose', label: t('compose'), children: detail.composeVersion || '—' },{ key: 'root', label: t('dataRoot'), children: <Space><Typography.Text code>{detail.dataRoot}</Typography.Text><Tag color={detail.dataRootWritable ? 'green' : 'red'}>{detail.dataRootWritable ? t('writable') : t('unavailable')}</Tag></Space> },{ key: 'ports', label: t('portPool'), children: <Space><Typography.Text>{detail.portStart}–{detail.portEnd}</Typography.Text><Tag color={detail.portProbeAvailable && detail.availablePort ? 'green' : 'orange'}>{detail.portProbeAvailable ? detail.availablePort ? t('firstAvailablePort', { port: detail.availablePort }) : t('portPoolExhausted') : t('unavailable')}</Tag></Space> },{ key: 'usedPorts', label: t('usedPorts'), children: detailReservation.ports.length ? detailReservation.ports.sort((a, b) => a - b).join(', ') : '—' }]} /></Card>
      </div>}
    </Drawer>
    <Modal title={deleteTarget ? `${t('delete')} ${deleteTarget.name}` : t('delete')} open={!!deleteTarget} onCancel={closeDelete} onOk={() => void remove()} confirmLoading={deleting} okText={t('delete')} okButtonProps={{ danger: true, disabled: deleteConfirm !== deleteTarget?.name || deleteNeedsRefresh || hostContextState !== 'ready' }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} maskClosable={!deleting} destroyOnHidden>
      <Alert className="delete-instance-alert" type="error" showIcon message={t('deleteHostWarningTitle')} description={t('deleteHostWarningDescription')} />
      {deleteError && <Alert className="form-save-alert" type="error" showIcon message={t('hostDeleteFailed')} description={<Space direction="vertical" size={4}><Typography.Text>{deleteError}</Typography.Text>{deleteNeedsRefresh && <Typography.Text type="secondary">{t('hostDeleteUnknownResultHint')}</Typography.Text>}</Space>} action={deleteNeedsRefresh ? <Button size="small" loading={deleteRefreshing} onClick={() => void refreshDeleteEvidence()}>{t('refreshStatus')}</Button> : undefined} />}
      <Typography.Paragraph>{t('deleteHostConfirmHint', { name: deleteTarget?.name || '' })}</Typography.Paragraph>
      <Input autoFocus aria-label={t('deleteHostConfirmLabel')} value={deleteConfirm} disabled={deleteNeedsRefresh || deleting} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={deleteTarget?.name} />
    </Modal>
  </>
}
