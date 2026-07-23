import { CloudServerOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SearchOutlined, ToolOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Collapse, Descriptions, Drawer, Dropdown, Form, Grid, Input, InputNumber, Modal, Progress, Select, Space, Steps, Switch, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { reservationForHost } from '../lib/host-capacity'
import { dockerManagementReady, hostConnectionReady, hostPortPoolInvalid } from '../lib/host-verification'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { selectRecoveryTasks } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import type { Host, Instance, Project, Task } from '../lib/types'
import { bytes } from '../lib/types'

interface HostForm {
  name: string; projectId?: string; sshAddress: string; sshPort: number; sshUser: string; authType: string;
  credential?: string; passphrase?: string; hostKey?: string; connectionAddress?: string; dataRoot: string;
  portStart: number; portEnd: number; manageDocker: boolean; maintenance: boolean; autoRestartDefault: boolean;
  proxyHttp?: string; proxyHttps?: string; proxyNoProxy?: string;
}

interface HostProbeResult {
  hostKey: string; os: string; distro: string; architecture: string; dockerVersion: string; composeVersion: string;
  passwordlessSudo: boolean; cpuCount: number; memoryBytes: number; diskTotalBytes: number; diskFreeBytes: number;
  dataRootWritable: boolean; portProbeAvailable: boolean; firstAvailablePort: number;
  verificationToken: string; verificationExpiresAt: string;
}

type VerificationReason = '' | 'connection' | 'docker_policy'

const verificationFields = new Set(['sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'dataRoot', 'portStart', 'portEnd'])
const hostDraftFields: Array<keyof HostForm> = ['name', 'projectId', 'sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'connectionAddress', 'dataRoot', 'portStart', 'portEnd', 'manageDocker', 'maintenance', 'autoRestartDefault', 'proxyHttp', 'proxyHttps', 'proxyNoProxy']
const hostStatuses = ['pending', 'online', 'offline', 'degraded', 'needs_docker', 'unsupported']
const safeCreateReturnPath = (value: string | null) => value?.startsWith('/instances?create=1') ? value : ''

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
  const { t, i18n } = useTranslation(); const { timezone } = useSystemSettings(); const { message, modal } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const hostID = params.get('host'); const returnTo = safeCreateReturnPath(params.get('returnTo')); const projectFilter = params.get('project') || ''; const [items, setItems] = useState<Host[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [instances, setInstances] = useState<Instance[]>([]); const [hostTasks, setHostTasks] = useState<Task[]>([]); const [loadError, setLoadError] = useState(''); const [supportingDataError, setSupportingDataError] = useState(''); const [detailError, setDetailError] = useState(''); const [verificationError, setVerificationError] = useState(''); const [saveError, setSaveError] = useState(''); const [open, setOpen] = useState(false); const [detail, setDetail] = useState<Host | null>(null); const [editing, setEditing] = useState<Host | null>(null); const [editorDirty, setEditorDirty] = useState(false); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [actioning, setActioning] = useState(''); const [fingerprint, setFingerprint] = useState(''); const [verificationToken, setVerificationToken] = useState(''); const [probe, setProbe] = useState<HostProbeResult | null>(null); const [verificationDirty, setVerificationDirty] = useState(false); const [verificationReason, setVerificationReason] = useState<VerificationReason>(''); const [search, setSearch] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [deleteTarget, setDeleteTarget] = useState<Host | null>(null); const [deleteConfirm, setDeleteConfirm] = useState(''); const [deleteError, setDeleteError] = useState(''); const [deleting, setDeleting] = useState(false); const verificationSection = useRef<HTMLDivElement>(null); const hostBaseline = useRef<HostForm | null>(null); const [form] = Form.useForm<HostForm>()
  const { user } = useAuth(); const { canOperate } = permissionsFor(user!)
  const screens = Grid.useBreakpoint()
  const hostConnectionValues = Form.useWatch([], { form, preserve: true })
  const manageDocker = Form.useWatch('manageDocker', form)
  const verificationRequired = !editing || verificationDirty
  const verificationReady = (!verificationRequired && !probe) || (!!fingerprint && !!verificationToken)
  const portPoolInvalid = hostPortPoolInvalid(hostConnectionValues)
  const connectionTestReady = hostConnectionReady(hostConnectionValues, !editing || verificationDirty)
  const dockerPolicyReady = dockerManagementReady(manageDocker, probe?.passwordlessSudo, editing?.manageDocker, verificationDirty)
  useEffect(() => {
    if (!probe && !verificationDirty && !verificationError) return
    const revealVerification = () => verificationSection.current?.scrollIntoView({ block: 'nearest' })
    const frame = window.requestAnimationFrame(revealVerification)
    const timer = window.setTimeout(revealVerification, 250)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [manageDocker, probe, verificationDirty, verificationError])
  const load = useCallback(async () => {
    try {
      const hosts = await api<{ items: Host[] }>('/hosts')
      setItems(hosts.items)
      setLoadError('')
      const [projectList, instanceList] = await Promise.allSettled([api<{ items: Project[] }>('/projects'), api<{ items: Instance[] }>('/instances')])
      if (projectList.status === 'fulfilled') setProjects(projectList.value.items)
      if (instanceList.status === 'fulfilled') setInstances(instanceList.value.items)
      const failed = [projectList, instanceList].find((result) => result.status === 'rejected')
      setSupportingDataError(failed?.status === 'rejected' ? errorMessage(failed.reason) : '')
    } catch (error) { setLoadError(errorMessage(error)) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => clearInterval(timer) }, [load])
  useEffect(() => { if (!hostID || open) return; const linked = items.find((item) => item.id === hostID); if (linked) setDetail(linked) }, [hostID, items, open])
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return items.filter((item) => {
      if (projectFilter && item.projectId !== projectFilter) return false
      if (statusFilter && item.status !== statusFilter) return false
      if (!needle) return true
      return `${item.name} ${item.sshAddress} ${item.sshUser} ${item.connectionAddress}`.toLocaleLowerCase().includes(needle)
    })
  }, [items, projectFilter, search, statusFilter])
  const setProjectFilter = (value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set('project', value)
    else next.delete('project')
    next.delete('host')
    setParams(next, { replace: true })
    setDetail(null)
  }
  const hasHostFilters = !!(projectFilter || statusFilter || search.trim())
  const clearHostFilters = () => {
    setSearch('')
    setStatusFilter('')
    setProjectFilter('')
  }
  const loadHostContext = useCallback(async (id: string) => {
    try {
      const [instanceList, taskList] = await Promise.all([api<{ items: Instance[] }>(`/instances?hostId=${encodeURIComponent(id)}`), api<{ items: Task[] }>(`/tasks?resourceType=host&resourceId=${encodeURIComponent(id)}`)])
      setInstances((current) => [...current.filter((instance) => instance.hostId !== id), ...instanceList.items])
      setHostTasks(taskList.items)
      setDetailError('')
    } catch (error) { setDetailError(errorMessage(error)) }
  }, [])
  useEffect(() => { if (!detail?.id) { setHostTasks([]); setDetailError(''); return }; void loadHostContext(detail.id); const timer = window.setInterval(() => void loadHostContext(detail.id), 5000); return () => clearInterval(timer) }, [detail?.id, loadHostContext])
  const show = (item?: Host) => {
    const values = (item
      ? { ...item, credential: '', passphrase: '' }
      : { name: '', projectId: projectFilter || undefined, sshAddress: '', sshPort: 22, sshUser: '', authType: 'private_key', credential: '', passphrase: '', dataRoot: '/opt/dbmock', portStart: 20000, portEnd: 40000, manageDocker: false, maintenance: false, autoRestartDefault: true }) as HostForm
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
    setVerificationReason('')
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
      setVerificationReason('')
      message.success(t('connectionVerified'))
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
      if (!dockerPolicyReady) { message.warning(t('dockerSudoRequired')); return }
      const result = await api<Host | { host: Host; task: Task }>(editing ? `/hosts/${editing.id}` : '/hosts', { method: editing ? 'PUT' : 'POST', body: { ...values, verificationToken } })
      setEditorDirty(false)
      if ('task' in result) {
        notifyTask(result.task)
        setOpen(false)
        if (returnTo) { navigate(`/tasks?task=${result.task.id}&continue=${encodeURIComponent(returnTo)}`); return }
      } else {
        message.success(t('saved'))
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
    const credentialOnly = changedKeys.every((key) => key === 'credential' || key === 'passphrase')
    const dockerManagementNeedsVerification = changed.manageDocker === true && !!editing && !probe
    const baseline = hostBaseline.current
    const connectionMatchesBaseline = !!baseline && [...verificationFields].every((key) => sameHostField(values, baseline, key as keyof HostForm))
    const dockerPolicyMatchesBaseline = !!baseline && (!!values.manageDocker === !!baseline.manageDocker || !values.manageDocker)
    if (editing && connectionMatchesBaseline && dockerPolicyMatchesBaseline && (connectionChanged || changed.manageDocker !== undefined)) {
      setFingerprint(editing.hostKey ?? ''); setVerificationToken(''); setProbe(null); setVerificationDirty(false); setVerificationReason('')
      return
    }
    if (changed.manageDocker === false && verificationReason === 'docker_policy' && editing) {
      setFingerprint(editing.hostKey ?? ''); setVerificationToken(''); setProbe(null); setVerificationDirty(false); setVerificationReason('')
      return
    }
    if (!connectionChanged && !dockerManagementNeedsVerification) return
    if (!fingerprint && !verificationDirty) return
    const reason = verificationReason === 'docker_policy' && credentialOnly ? 'docker_policy' : connectionChanged ? 'connection' : 'docker_policy'
    setFingerprint(''); setVerificationToken(''); setProbe(null); setVerificationDirty(true); setVerificationReason(reason)
  }
  const openDetail = (item: Host) => { const next = new URLSearchParams(params); next.set('host', item.id); setParams(next, { replace: true }); setDetail(item) }
  const closeDetail = () => { setDetail(null); if (hostID) { const next = new URLSearchParams(params); next.delete('host'); setParams(next, { replace: true }) } }
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
  const cancelDatabaseCreation = () => { setOpen(false); navigate('/catalog') }
  const showDelete = (item: Host) => {
    setDeleteTarget(item)
    setDeleteConfirm('')
    setDeleteError('')
  }
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setDeleteConfirm('')
    setDeleteError('')
  }
  const remove = async () => {
    if (!deleteTarget || deleteConfirm !== deleteTarget.name) return
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
    } finally {
      setDeleting(false)
    }
  }
  const relatedInstances = detail ? instances.filter((instance) => instance.hostId === detail.id) : []
  const detailReservation = detail ? reservationForHost(instances, detail.id) : { cpu: 0, memory: 0, disk: 0, ports: [] }
  const { activeTask, failedTask, operationTask } = selectRecoveryTasks(hostTasks, Boolean(detail && ['offline', 'needs_docker', 'unsupported'].includes(detail.status)))
  const retryTask = async () => {
    if (!failedTask || !detail) return
    try {
      setActioning('retry-task')
      const retried = await api<Task>(`/tasks/${failedTask.id}/retry`, { method: 'POST', body: {} })
      setHostTasks((current) => [retried, ...current])
      notifyTask(retried)
      await Promise.all([load(), loadHostContext(detail.id)])
    } catch (error) { message.error(errorMessage(error)) } finally { setActioning('') }
  }
  const columns = useMemo(() => [
    { title: t('name'), dataIndex: 'name', width: 190, render: (value: string, item: Host) => <div className="host-name-cell"><Button type="link" onClick={() => openDetail(item)}><CloudServerOutlined /> {value}</Button><Typography.Text type="secondary">{projects.find((project) => project.id === item.projectId)?.name || t('noProject')}</Typography.Text></div> },
    { title: t('status'), dataIndex: 'status', width: 110, render: (value: string, item: Host) => <div className="host-status-cell"><StatusTag value={value} />{item.maintenance && <Tag>{t('maintenance')}</Tag>}</div> },
    { title: t('ssh'), width: 220, render: (_: unknown, item: Host) => <><Typography.Text>{item.sshUser}@{item.sshAddress}:{item.sshPort}</Typography.Text><br /><Typography.Text type="secondary">{item.distro || item.os || '—'} / {item.architecture || '—'}</Typography.Text></> },
    { title: t('docker'), width: 145, render: (_: unknown, item: Host) => <><Typography.Text>{item.dockerVersion || t('dockerNotInstalled')}</Typography.Text><br /><Typography.Text type="secondary">{t('compose')} {item.composeVersion || '—'}</Typography.Text></> },
    { title: t('schedulingCapacity'), width: 260, render: (_: unknown, item: Host) => { const related = instances.filter((instance) => instance.hostId === item.id); const reserved = reservationForHost(instances, item.id); return <div className="host-list-capacity"><div><DatabaseOutlined /><Typography.Text>{t('managedInstanceCount', { count: related.length })}</Typography.Text></div><Typography.Text type="secondary">{t('reservedCapacity')}: {reserved.cpu} CPU · {bytes(reserved.memory)} · {bytes(reserved.disk)}</Typography.Text></div> } },
    { title: t('actions'), width: 64, align: 'right' as const, render: (_: unknown, item: Host) => canOperate ? <Dropdown trigger={['click']} menu={{ items: [
      { key: 'probe', icon: <ReloadOutlined />, label: t('reprobeHost'), disabled: !!actioning, onClick: () => void action(item, 'probe') },
      { key: 'edit', icon: <EditOutlined />, label: t('edit'), disabled: !!actioning, onClick: () => show(item) },
      { type: 'divider' as const },
      { key: 'install', icon: <ToolOutlined />, label: t('installDocker'), disabled: !item.manageDocker || item.status === 'offline' || !!actioning, onClick: () => void action(item, 'install_docker') },
      { key: 'upgrade', label: t('upgradeDocker'), disabled: !item.manageDocker || item.status !== 'online' || !!actioning, onClick: () => void action(item, 'upgrade_docker') },
      { key: 'proxy', label: t('applyDockerProxy'), disabled: !item.manageDocker || item.status !== 'online' || item.os === 'darwin' || !!actioning, onClick: () => void action(item, 'configure_proxy') },
    ] }}><Button type="text" aria-label={t('moreActions')} title={t('moreActions')} icon={<MoreOutlined />} loading={!!actioning} /></Dropdown> : null },
  ], [actioning, canOperate, instances, projects, t])
  const capacityItems = detail ? [
    { key: 'cpu', label: t('cpu'), reserved: detailReservation.cpu, limit: detail.cpuCount * .9, format: (value: number) => `${value.toFixed(value % 1 ? 1 : 0)} CPU` },
    { key: 'memory', label: t('memory'), reserved: detailReservation.memory, limit: detail.memoryBytes * .8, format: bytes },
    { key: 'disk', label: t('disk'), reserved: detailReservation.disk, limit: detail.diskFreeBytes * .8, format: bytes },
  ] : []
  const operationPanel = operationTask && <div className={`instance-operation host-operation is-${activeTask ? 'active' : 'failed'}`}>
    <div className="instance-operation-copy"><Space wrap><StatusTag value={operationTask.status} /><Typography.Text strong>{translateCode(t, operationTask.kind, 'taskKind')}</Typography.Text><Typography.Text type="secondary">· {translateCode(t, operationTask.stage)}</Typography.Text></Space><Typography.Paragraph type={activeTask ? 'secondary' : 'danger'}>{activeTask ? translateCode(t, operationTask.message, 'taskMessage') : operationTask.errorCode && operationTask.errorCode !== 'task_failed' ? translateCode(t, operationTask.errorCode, 'taskError') : operationTask.errorMessage || translateCode(t, operationTask.message, 'taskMessage')}</Typography.Paragraph></div>
    {activeTask && <Progress className="instance-operation-progress" percent={operationTask.progress} status="active" size="small" />}
    <Space className="instance-operation-actions">{canOperate && failedTask && !activeTask && <Button type="primary" icon={<ReloadOutlined />} loading={actioning === 'retry-task'} disabled={!!actioning && actioning !== 'retry-task'} onClick={() => void retryTask()}>{t('retryTask')}</Button>}<Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewTask')}</Button></Space>
  </div>
  const creationProgress = <div className="host-continuation-copy"><Typography.Paragraph type="secondary">{t('databaseCreationHostHint')}</Typography.Paragraph><Steps className="host-continuation-steps" current={0} size="small" responsive={false} items={[{ title: t('hostSetupStepConnect') }, { title: t('hostSetupStepVerify') }, { title: t('hostSetupStepCreate') }]} /></div>
  return <><PageHeader title={t('hosts')} description={t('hostsDescription')} />
    {canOperate && returnTo && <Alert className="host-continuation-banner" type="info" showIcon icon={<DatabaseOutlined />} message={t('databaseCreationPending')} description={creationProgress} action={<Space direction="vertical" size={4}><Button type="primary" size="small" onClick={() => show()}>{t('continueAddHost')}</Button><Button type="link" size="small" onClick={cancelDatabaseCreation}>{t('returnToCatalog')}</Button></Space>} />}
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('hostListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {supportingDataError && <Alert className="instance-page-alert" type="warning" showIcon message={t('hostSupportingDataLoadFailed')} description={supportingDataError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {(items.length > 0 || !loadError) && <Card className="host-table-card"><div className="embedded-toolbar host-toolbar"><div className="host-list-heading"><Typography.Text strong>{t('hosts')}</Typography.Text><Typography.Text type="secondary">{t(hasHostFilters ? 'hostFilteredResultCount' : 'hostResultCount', { filtered: filteredItems.length, total: items.length, count: items.length })}</Typography.Text></div><Space wrap className="host-filter-controls"><Input allowClear className="host-search" aria-label={t('hostSearchLabel')} placeholder={t('hostSearchPlaceholder')} prefix={<SearchOutlined />} value={search} onChange={(event) => setSearch(event.target.value)} /><Select className="host-project-filter" aria-label={t('project')} value={projectFilter} onChange={setProjectFilter} options={[{ value: '', label: t('allProjects') }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /><Select className="host-status-filter" aria-label={t('status')} value={statusFilter} onChange={setStatusFilter} options={[{ value: '', label: t('allStatuses') }, ...hostStatuses.map((status) => ({ value: status, label: translateCode(t, status) }))]} /><Button loading={loading} icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>{canOperate && items.length > 0 && <Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('addHost')}</Button>}</Space></div><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} pagination={false} tableLayout="fixed" scroll={{ x: 989 }} locale={{ emptyText: <EmptyState compact action={hasHostFilters ? clearHostFilters : canOperate ? () => show() : undefined} actionLabel={hasHostFilters ? t('clearFilters') : canOperate ? t('addHost') : undefined} description={t(hasHostFilters ? 'hostsFilteredEmptyDescription' : 'noHostsDescription')} /> }} /></Card>}
    <Modal className="host-editor-modal" title={editing ? t('edit') : t('addHost')} open={open} onCancel={closeEditor} width={760} style={{ top: screens.md === false ? 12 : 32 }} styles={{ body: { maxHeight: screens.md === false ? 'calc(100dvh - 220px)' : 'calc(100vh - 160px)', overflowY: 'auto', paddingRight: 4 } }} destroyOnHidden footer={<div className="workflow-modal-footer"><Button disabled={saving || testing} onClick={closeEditor}>{t('cancel')}</Button><Space>{(!editing || verificationDirty || !fingerprint) && <Button loading={testing} disabled={saving || !connectionTestReady} icon={<SafetyCertificateOutlined />} onClick={() => void test()}>{t('testConnection')}</Button>}<Button type="primary" loading={saving} disabled={testing || !verificationReady || !dockerPolicyReady || (!!editing && !editorDirty)} onClick={() => void submit()}>{t('save')}</Button></Space></div>}>
      <Form form={form} className="host-editor-form" layout="vertical" requiredMark={false} autoComplete="off" onValuesChange={invalidateVerification}><Alert className="form-save-alert" type="info" showIcon message={t(editing ? 'hostEditFormHint' : 'hostCreateFormHint')} />{saveError && <Alert className="form-save-alert" type="error" showIcon message={t('hostSaveFailed')} description={saveError} />}{returnTo && !editing && <Alert className="host-continuation-modal-alert" type="info" showIcon icon={<DatabaseOutlined />} message={t('databaseCreationPending')} description={creationProgress} />}<Typography.Text className="form-section-label">{t('connectionSettings')}</Typography.Text><div className="form-grid"><Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input autoFocus autoComplete="off" maxLength={120} placeholder={t('hostNamePlaceholder')} /></Form.Item><Form.Item name="projectId" label={t('project')}><Select allowClear placeholder={t('selectProjectOptional')} options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item><Form.Item name="sshAddress" label={t('sshAddress')} rules={[{ required: true, whitespace: true, max: 255 }]}><Input autoComplete="off" maxLength={255} placeholder={t('sshAddressPlaceholder')} /></Form.Item><Form.Item name="sshPort" label={t('sshPort')} rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="sshUser" label={t('sshUser')} rules={[{ required: true, whitespace: true, max: 255 }]}><Input autoComplete="off" maxLength={255} placeholder={t('sshUserPlaceholder')} data-1p-ignore data-lpignore="true" /></Form.Item><Form.Item name="authType" label={t('authentication')}><Select options={[{ value: 'private_key', label: t('privateKey') }, { value: 'password', label: t('password') }]} /></Form.Item></div>
        <Form.Item noStyle shouldUpdate={(a, b) => a.authType !== b.authType}>{({ getFieldValue }) => <><Form.Item name="credential" label={getFieldValue('authType') === 'password' ? t('password') : t('privateKey')} extra={t('hostCredentialHint')} rules={!editing || verificationDirty ? [{ required: true }] : []}>{getFieldValue('authType') === 'password' ? <Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /> : <Input.TextArea rows={4} autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={t('privateKeyPlaceholder')} />}</Form.Item>{getFieldValue('authType') === 'private_key' && <Form.Item name="passphrase" label={t('privateKeyPassphrase')}><Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>}</>}</Form.Item>
        <Collapse className="host-advanced" items={[{ key: 'advanced', label: <div><Typography.Text strong>{t('advancedSettings')}</Typography.Text><Typography.Text type="secondary">{t('advancedHostSettingsHint')}</Typography.Text></div>, children: <><div className="form-grid"><Form.Item name="connectionAddress" label={t('databaseConnectionAddress')} rules={[{ max: 255 }]}><Input maxLength={255} placeholder={t('defaultsToSSHAddress')} /></Form.Item><Form.Item name="dataRoot" label={t('managedDataRoot')} rules={[{ required: true, whitespace: true, max: 4096 }]}><Input maxLength={4096} /></Form.Item><Form.Item name="portStart" label={t('portPoolStart')} rules={[{ required: true, type: 'number', min: 1, max: 65535 }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="portEnd" label={t('portPoolEnd')} dependencies={['portStart']} validateStatus={portPoolInvalid ? 'error' : undefined} help={portPoolInvalid ? t('portPoolRangeInvalid') : undefined} rules={[{ required: true, type: 'number', min: 1, max: 65535 },({ getFieldValue }) => ({ validator: (_, value) => value === undefined || value >= getFieldValue('portStart') ? Promise.resolve() : Promise.reject(new Error(t('portPoolRangeInvalid'))) })]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></div><Card size="small" title={t('proxy')} className="form-section"><div className="form-grid"><Form.Item name="proxyHttp" label="HTTP_PROXY" rules={[{ max: 2048 }]}><Input maxLength={2048} /></Form.Item><Form.Item name="proxyHttps" label="HTTPS_PROXY" rules={[{ max: 2048 }]}><Input maxLength={2048} /></Form.Item></div><Form.Item name="proxyNoProxy" label="NO_PROXY" rules={[{ max: 4096 }]}><Input maxLength={4096} /></Form.Item></Card></> },{ key: 'policies', label: <div><Typography.Text strong>{t('hostPolicies')}</Typography.Text><Typography.Text type="secondary">{t('hostPoliciesHint')}</Typography.Text></div>, children: <div className="host-policy-list"><div className="host-policy-item"><div><Typography.Text strong>{t('allowDockerManagement')}</Typography.Text><Typography.Text type="secondary">{t('dockerManagementPolicyHint')}</Typography.Text>{manageDocker && verificationReason === 'docker_policy' && <Typography.Text type="danger" role="alert" className="host-policy-warning">{t('dockerPolicyVerificationRequired')}</Typography.Text>}{manageDocker && probe && !probe.passwordlessSudo && <Typography.Text type="danger" role="alert" className="host-policy-warning">{t('dockerManagementBlockedInline')}</Typography.Text>}</div><Form.Item name="manageDocker" valuePropName="checked" noStyle><Switch aria-label={t('allowDockerManagement')} /></Form.Item></div><div className="host-policy-item"><div><Typography.Text strong>{t('autoRestart')}</Typography.Text><Typography.Text type="secondary">{t('autoRestartPolicyHint')}</Typography.Text></div><Form.Item name="autoRestartDefault" valuePropName="checked" noStyle><Switch aria-label={t('autoRestart')} /></Form.Item></div><div className="host-policy-item"><div><Typography.Text strong>{t('maintenance')}</Typography.Text><Typography.Text type="secondary">{t('maintenancePolicyHint')}</Typography.Text></div><Form.Item name="maintenance" valuePropName="checked" noStyle><Switch aria-label={t('maintenance')} /></Form.Item></div></div> }]} />
        {verificationRequired && <div ref={verificationSection} className="verification-section"><Typography.Text className="form-section-label">{t('connectionVerification')}</Typography.Text>{verificationError ? <Alert type="error" showIcon message={t('hostConnectionTestFailed')} description={<Space direction="vertical" size={2}><Typography.Text>{verificationError}</Typography.Text><Typography.Text type="secondary">{t('hostConnectionFailureHint')}</Typography.Text></Space>} /> : probe ? <><Alert type="success" showIcon message={t('connectionVerified')} description={<><Descriptions size="small" column={2} items={[{ key: 'system', label: t('testResultSystem'), children: `${probe.os}/${probe.architecture}` },{ key: 'docker', label: t('testResultDocker'), children: probe.dockerVersion ? `${probe.dockerVersion} / ${probe.composeVersion || '—'}` : t('dockerNotInstalled') },{ key: 'sudo', label: t('passwordlessSudo'), children: probe.passwordlessSudo ? t('available') : t('unavailable') },{ key: 'resources', label: t('testResultResources'), children: `${probe.cpuCount} CPU · ${bytes(probe.memoryBytes)} · ${bytes(probe.diskFreeBytes)}` },{ key: 'root', label: t('testResultDataRoot'), children: probe.dataRootWritable ? t('writable') : t('unavailable') },{ key: 'port', label: t('testResultPortPool'), children: probe.portProbeAvailable ? probe.firstAvailablePort ? t('firstAvailablePort', { port: probe.firstAvailablePort }) : t('portPoolExhausted') : t('unavailable') }]} /><Typography.Text code copyable className="fingerprint-value">{fingerprint.split(' ')[0]}</Typography.Text></>} />{probe.portProbeAvailable && !probe.firstAvailablePort && <Alert type="warning" showIcon message={t('portPoolExhausted')} description={t('portPoolExhaustedHint')} />}{manageDocker && !probe.passwordlessSudo && <Alert type="warning" showIcon message={t('dockerSudoRequired')} description={t('dockerSudoRequiredHint')} />}</> : <Alert type={verificationDirty ? 'warning' : 'info'} showIcon message={verificationDirty ? t(verificationReason === 'docker_policy' ? 'dockerPolicyVerificationRequired' : 'connectionChanged') : t(portPoolInvalid ? 'portPoolRangeInvalid' : connectionTestReady ? 'connectionVerificationHint' : 'connectionDetailsIncomplete')} />}</div>}
      </Form>
    </Modal>
    <Drawer className="host-detail-drawer" title={detail ? <div className="host-detail-title"><div><CloudServerOutlined /><Typography.Text strong>{detail.name}</Typography.Text></div><StatusTag value={detail.status} /></div> : t('hostDetails')} open={!!detail} onClose={closeDetail} width={780} destroyOnHidden footer={canOperate && detail ? <div className="workflow-drawer-footer"><Button danger icon={<DeleteOutlined />} disabled={relatedInstances.length > 0 || !!activeTask || !!actioning} title={relatedInstances.length ? t('hostDeleteBlocked') : activeTask ? t('hostOperationInProgress') : t('delete')} onClick={() => showDelete(detail)}>{t('delete')}</Button><Space wrap><Button icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!activeTask || (!!actioning && actioning !== 'probe')} onClick={() => void action(detail, 'probe')}>{t('reprobeHost')}</Button><Button icon={<EditOutlined />} disabled={!!activeTask || !!actioning} onClick={() => show(detail)}>{t('edit')}</Button><Dropdown trigger={['click']} menu={{ items: [{ key: 'install', icon: <ToolOutlined />, label: t('installDocker'), disabled: !!activeTask || !detail.manageDocker || detail.status === 'offline' || !!actioning },{ key: 'upgrade', label: t('upgradeDocker'), disabled: !!activeTask || !detail.manageDocker || detail.status !== 'online' || !!actioning },{ key: 'proxy', label: t('applyDockerProxy'), disabled: !!activeTask || !detail.manageDocker || detail.status !== 'online' || detail.os === 'darwin' || !!actioning }], onClick: ({ key }) => void action(detail, key === 'install' ? 'install_docker' : key === 'upgrade' ? 'upgrade_docker' : 'configure_proxy') }}><Button icon={<MoreOutlined />} disabled={!!activeTask || !!actioning} title={activeTask ? t('hostOperationInProgress') : t('moreActions')}>{t('moreActions')}</Button></Dropdown></Space></div> : undefined}>
      {detail && <div className="host-detail">
        {detailError && <Alert type="warning" showIcon message={t('hostContextLoadFailed')} description={detailError} action={<Button size="small" onClick={() => void loadHostContext(detail.id)}>{t('retry')}</Button>} />}
        {operationPanel}
        <div className={`host-health-banner is-${detail.status === 'online' ? 'success' : detail.status === 'needs_docker' ? 'warning' : 'error'}`}>
          <div><StatusTag value={detail.status} /><Typography.Text strong>{t('currentHostState')}</Typography.Text></div>
          <Typography.Paragraph>{detail.statusMessage ? translateCode(t, detail.statusMessage, 'statusMessage') : detail.status === 'online' ? t('hostOnlineHint') : detail.status === 'needs_docker' ? t('hostNeedsDockerHint') : t('hostOfflineHint')}</Typography.Paragraph>
          {canOperate && detail.status === 'needs_docker' && <div className="host-health-guidance"><Typography.Text>{t(detail.manageDocker ? 'hostNeedsDockerManagedHint' : 'hostNeedsDockerHint')}</Typography.Text>{detail.manageDocker ? <Button size="small" type="primary" icon={<ToolOutlined />} loading={actioning === 'install_docker'} disabled={!!activeTask || (!!actioning && actioning !== 'install_docker')} onClick={() => void action(detail, 'install_docker')}>{t('installDocker')}</Button> : <Button size="small" icon={<EditOutlined />} disabled={!!activeTask || !!actioning} onClick={() => show(detail)}>{t('editDockerPolicy')}</Button>}</div>}
          <div className="host-health-facts"><span><Typography.Text type="secondary">{t('lastChecked')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastCheckedAt, i18n.language, timezone)}</Typography.Text></span><span><Typography.Text type="secondary">{t('lastSeen')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastSeenAt, i18n.language, timezone)}</Typography.Text></span><span><Typography.Text type="secondary">{t('consecutiveFailures')}</Typography.Text><Typography.Text>{detail.consecutiveFailures}</Typography.Text></span></div>
        </div>
        <Card size="small" title={t('schedulingCapacity')} extra={<Typography.Text type="secondary">{t('schedulingCapacityPolicy')}</Typography.Text>}><div className="host-capacity-grid">{capacityItems.map((item) => <div className="host-capacity-item" key={item.key}><div><Typography.Text strong>{item.label}</Typography.Text><Typography.Text type="secondary">{t('capacityRemaining', { value: item.format(Math.max(0, item.limit - item.reserved)) })}</Typography.Text></div><Progress percent={percent(item.reserved, item.limit)} size="small" status={item.reserved > item.limit ? 'exception' : 'normal'} /><Typography.Text type="secondary">{t('capacityReservedOf', { reserved: item.format(item.reserved), limit: item.format(item.limit) })}</Typography.Text></div>)}</div></Card>
        <Card size="small" title={t('managedInstances')} extra={<Typography.Text type="secondary">{t('managedInstanceCount', { count: relatedInstances.length })}</Typography.Text>} className="host-instance-card"><Table size="small" rowKey="id" pagination={false} dataSource={relatedInstances} locale={{ emptyText: <EmptyState compact description={t('noManagedInstances')} /> }} columns={[{ title: t('name'), dataIndex: 'name', render: (value: string, instance: Instance) => <Button type="link" className="description-link" onClick={() => navigate(`/instances/${instance.id}`)}>{value}</Button> },{ title: t('status'), dataIndex: 'status', width: 110, render: (value: string) => <StatusTag value={value} /> },{ title: t('resources'), width: 190, render: (_: unknown, instance: Instance) => `${instance.cpu} CPU · ${bytes(instance.memoryBytes)} · ${bytes(instance.reservedDiskBytes)}` },{ title: t('port'), dataIndex: 'hostPort', width: 85 }]} /></Card>
        <Card size="small" title={t('hostConfiguration')}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'project', label: t('project'), children: projects.find((project) => project.id === detail.projectId)?.name || t('noProject') },{ key: 'ssh', label: t('ssh'), children: `${detail.sshUser}@${detail.sshAddress}:${detail.sshPort}` },{ key: 'connect', label: t('databaseAddress'), children: detail.connectionAddress || detail.sshAddress },{ key: 'system', label: t('system'), children: `${detail.distro || detail.os || '—'} / ${detail.architecture || '—'}` },{ key: 'docker', label: t('docker'), children: detail.dockerVersion || t('dockerNotInstalled') },{ key: 'compose', label: t('compose'), children: detail.composeVersion || '—' },{ key: 'root', label: t('dataRoot'), children: <Space><Typography.Text code>{detail.dataRoot}</Typography.Text><Tag color={detail.dataRootWritable ? 'green' : 'red'}>{detail.dataRootWritable ? t('writable') : t('unavailable')}</Tag></Space> },{ key: 'ports', label: t('portPool'), children: <Space><Typography.Text>{detail.portStart}–{detail.portEnd}</Typography.Text><Tag color={detail.portProbeAvailable && detail.availablePort ? 'green' : 'orange'}>{detail.portProbeAvailable ? detail.availablePort ? t('firstAvailablePort', { port: detail.availablePort }) : t('portPoolExhausted') : t('unavailable')}</Tag></Space> },{ key: 'usedPorts', label: t('usedPorts'), children: detailReservation.ports.length ? detailReservation.ports.sort((a, b) => a - b).join(', ') : '—' },{ key: 'policies', label: t('hostPolicies'), children: <Space wrap><Tag color={detail.manageDocker ? 'blue' : undefined}>{t('dockerManagement')}: {detail.manageDocker ? t('enabled') : t('disabled')}</Tag><Tag color={detail.autoRestartDefault ? 'green' : undefined}>{t('autoRestart')}: {detail.autoRestartDefault ? t('enabled') : t('disabled')}</Tag><Tag color={detail.maintenance ? 'orange' : undefined}>{t('maintenance')}: {detail.maintenance ? t('enabled') : t('disabled')}</Tag></Space>, span: 2 },{ key: 'labels', label: t('labels'), children: Object.keys(detail.labels || {}).length ? <Space wrap>{Object.entries(detail.labels).map(([key, value]) => <Tag key={key}>{key}={value}</Tag>)}</Space> : '—', span: 2 }]} /></Card>
      </div>}
    </Drawer>
    <Modal title={deleteTarget ? `${t('delete')} ${deleteTarget.name}` : t('delete')} open={!!deleteTarget} onCancel={closeDelete} onOk={() => void remove()} confirmLoading={deleting} okText={t('delete')} okButtonProps={{ danger: true, disabled: deleteConfirm !== deleteTarget?.name }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} maskClosable={!deleting} destroyOnHidden>
      <Alert className="delete-instance-alert" type="error" showIcon message={t('deleteHostWarningTitle')} description={t('deleteHostWarningDescription')} />
      {deleteError && <Alert className="form-save-alert" type="error" showIcon message={t('hostDeleteFailed')} description={deleteError} />}
      <Typography.Paragraph>{t('deleteHostConfirmHint', { name: deleteTarget?.name || '' })}</Typography.Paragraph>
      <Input autoFocus aria-label={t('deleteHostConfirmLabel')} value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={deleteTarget?.name} />
    </Modal>
  </>
}
