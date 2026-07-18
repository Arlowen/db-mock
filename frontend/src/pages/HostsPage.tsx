import { CloudServerOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, MoreOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, ToolOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Collapse, Descriptions, Drawer, Dropdown, Form, Input, InputNumber, Modal, Popconfirm, Progress, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
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
  cpuCount: number; memoryBytes: number; diskTotalBytes: number; diskFreeBytes: number;
}

const verificationFields = new Set(['sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'dataRoot'])
const safeCreateReturnPath = (value: string | null) => value?.startsWith('/instances?create=1') ? value : ''

interface HostReservation { cpu: number; memory: number; disk: number; ports: number[] }

function reservationFor(instances: Instance[], hostId: string): HostReservation {
  return instances.filter((instance) => instance.hostId === hostId).reduce((total, instance) => ({
    cpu: total.cpu + instance.cpu,
    memory: total.memory + instance.memoryBytes,
    disk: total.disk + instance.reservedDiskBytes,
    ports: instance.hostPort ? [...total.ports, instance.hostPort] : total.ports,
  }), { cpu: 0, memory: 0, disk: 0, ports: [] } as HostReservation)
}

function percent(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.round(used * 100 / limit)) : 0
}

export function HostsPage() {
  const { t, i18n } = useTranslation(); const { message } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const hostID = params.get('host'); const returnTo = safeCreateReturnPath(params.get('returnTo')); const [items, setItems] = useState<Host[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [instances, setInstances] = useState<Instance[]>([]); const [hostTasks, setHostTasks] = useState<Task[]>([]); const [detailError, setDetailError] = useState(''); const [open, setOpen] = useState(false); const [detail, setDetail] = useState<Host | null>(null); const [editing, setEditing] = useState<Host | null>(null); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [testing, setTesting] = useState(false); const [actioning, setActioning] = useState(''); const [fingerprint, setFingerprint] = useState(''); const [probe, setProbe] = useState<HostProbeResult | null>(null); const [verificationDirty, setVerificationDirty] = useState(false); const [form] = Form.useForm<HostForm>()
  const load = useCallback(async () => {
    try {
      const hosts = await api<{ items: Host[] }>('/hosts')
      setItems(hosts.items)
      const [projectList, instanceList] = await Promise.allSettled([api<{ items: Project[] }>('/projects'), api<{ items: Instance[] }>('/instances')])
      if (projectList.status === 'fulfilled') setProjects(projectList.value.items)
      if (instanceList.status === 'fulfilled') setInstances(instanceList.value.items)
      const failed = [projectList, instanceList].find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') message.warning(errorMessage(failed.reason))
    } catch (error) { message.error(errorMessage(error)) } finally { setLoading(false) }
  }, [message])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => clearInterval(timer) }, [load])
  useEffect(() => { if (!hostID) return; const linked = items.find((item) => item.id === hostID); if (linked) setDetail(linked) }, [hostID, items])
  const loadHostContext = useCallback(async (id: string) => {
    try {
      const [instanceList, taskList] = await Promise.all([api<{ items: Instance[] }>(`/instances?hostId=${encodeURIComponent(id)}`), api<{ items: Task[] }>(`/tasks?resourceType=host&resourceId=${encodeURIComponent(id)}`)])
      setInstances((current) => [...current.filter((instance) => instance.hostId !== id), ...instanceList.items])
      setHostTasks(taskList.items)
      setDetailError('')
    } catch (error) { setDetailError(errorMessage(error)) }
  }, [])
  useEffect(() => { if (!detail?.id) { setHostTasks([]); setDetailError(''); return }; void loadHostContext(detail.id); const timer = window.setInterval(() => void loadHostContext(detail.id), 5000); return () => clearInterval(timer) }, [detail?.id, loadHostContext])
  const show = (item?: Host) => { if (item) setDetail(null); form.resetFields(); setEditing(item ?? null); setFingerprint(item?.hostKey ?? ''); setProbe(null); setVerificationDirty(false); form.setFieldsValue(item ? { ...item, credential: '', passphrase: '' } : { sshPort: 22, authType: 'private_key', dataRoot: '/opt/dbmock', portStart: 20000, portEnd: 40000, manageDocker: false, maintenance: false, autoRestartDefault: true }); setOpen(true) }
  useEffect(() => { if (params.get('create') === '1') { show(); const next = new URLSearchParams(params); next.delete('create'); setParams(next, { replace: true }) } }, [params, setParams])
  const test = async () => { try { const values = await form.validateFields(['sshAddress', 'sshPort', 'sshUser', 'authType', 'credential', 'passphrase', 'dataRoot']); setTesting(true); setFingerprint(''); setProbe(null); const result = await api<HostProbeResult>('/hosts/test', { method: 'POST', body: { ...values, hostKey: '' } }); setFingerprint(result.hostKey); setProbe(result); setVerificationDirty(false); message.success(t('connectionVerified')) } catch (e) { if (e instanceof Error) message.error(errorMessage(e)) } finally { setTesting(false) } }
  const submit = async () => { try { setSaving(true); const values = await form.validateFields(); if (!fingerprint && !editing) { message.warning(t('confirmFingerprint')); return } const result = await api<Host | { host: Host; task: Task }>(editing ? `/hosts/${editing.id}` : '/hosts', { method: editing ? 'PUT' : 'POST', body: { ...values, hostKey: fingerprint } }); if ('task' in result) { notifyTask(result.task); setOpen(false); if (returnTo) { navigate(`/tasks?task=${result.task.id}&continue=${encodeURIComponent(returnTo)}`); return } } else message.success(t('saved')); setOpen(false); await load() } catch (e) { if (e instanceof Error) message.error(errorMessage(e)) } finally { setSaving(false) } }
  const action = async (item: Host, actionName: string) => {
    try {
      setActioning(actionName)
      const task = await api<Task>(`/hosts/${item.id}/actions/${actionName}`, { method: 'POST', body: {} })
      setHostTasks((current) => [task, ...current])
      notifyTask(task)
      await Promise.all([load(), loadHostContext(item.id)])
    } catch (e) { message.error(errorMessage(e)) } finally { setActioning('') }
  }
  const invalidateVerification = (changed: Partial<HostForm>) => { if (!fingerprint || !Object.keys(changed).some((key) => verificationFields.has(key))) return; setFingerprint(''); setProbe(null); setVerificationDirty(true) }
  const openDetail = (item: Host) => { const next = new URLSearchParams(params); next.set('host', item.id); setParams(next, { replace: true }); setDetail(item) }
  const closeDetail = () => { setDetail(null); if (hostID) { const next = new URLSearchParams(params); next.delete('host'); setParams(next, { replace: true }) } }
  const closeEditor = () => { if (saving || testing) return; setOpen(false); if (editing && hostID) setDetail(items.find((item) => item.id === hostID) ?? editing) }
  const remove = async (item: Host) => { try { await api(`/hosts/${item.id}`, { method: 'DELETE', body: { confirmName: item.name } }); closeDetail(); await load() } catch (e) { message.error(errorMessage(e)) } }
  const relatedInstances = detail ? instances.filter((instance) => instance.hostId === detail.id) : []
  const detailReservation = detail ? reservationFor(instances, detail.id) : { cpu: 0, memory: 0, disk: 0, ports: [] }
  const activeTask = hostTasks.find((task) => task.status === 'queued' || task.status === 'running')
  const failedTask = detail && ['offline', 'needs_docker', 'unsupported'].includes(detail.status) ? hostTasks.find((task) => ['failed', 'interrupted', 'canceled'].includes(task.status)) : undefined
  const operationTask = activeTask || failedTask
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
    { title: t('schedulingCapacity'), width: 260, render: (_: unknown, item: Host) => { const related = instances.filter((instance) => instance.hostId === item.id); const reserved = reservationFor(instances, item.id); return <div className="host-list-capacity"><div><DatabaseOutlined /><Typography.Text>{t('managedInstanceCount', { count: related.length })}</Typography.Text></div><Typography.Text type="secondary">{t('reservedCapacity')}: {reserved.cpu} CPU · {bytes(reserved.memory)} · {bytes(reserved.disk)}</Typography.Text></div> } },
    { title: t('actions'), width: 64, align: 'right' as const, render: (_: unknown, item: Host) => <Dropdown trigger={['click']} menu={{ items: [
      { key: 'probe', icon: <ReloadOutlined />, label: t('reprobeHost'), disabled: !!actioning, onClick: () => void action(item, 'probe') },
      { key: 'edit', icon: <EditOutlined />, label: t('edit'), disabled: !!actioning, onClick: () => show(item) },
      { type: 'divider' as const },
      { key: 'install', icon: <ToolOutlined />, label: t('installDocker'), disabled: !item.manageDocker || item.status === 'offline' || !!actioning, onClick: () => void action(item, 'install_docker') },
      { key: 'upgrade', label: t('upgradeDocker'), disabled: !item.manageDocker || item.status !== 'online' || !!actioning, onClick: () => void action(item, 'upgrade_docker') },
      { key: 'proxy', label: t('applyDockerProxy'), disabled: !item.manageDocker || item.status !== 'online' || item.os === 'darwin' || !!actioning, onClick: () => void action(item, 'configure_proxy') },
    ] }}><Button type="text" aria-label={t('moreActions')} title={t('moreActions')} icon={<MoreOutlined />} loading={!!actioning} /></Dropdown> },
  ], [actioning, instances, projects, t])
  const capacityItems = detail ? [
    { key: 'cpu', label: t('cpu'), reserved: detailReservation.cpu, limit: detail.cpuCount * .9, format: (value: number) => `${value.toFixed(value % 1 ? 1 : 0)} CPU` },
    { key: 'memory', label: t('memory'), reserved: detailReservation.memory, limit: detail.memoryBytes * .8, format: bytes },
    { key: 'disk', label: t('disk'), reserved: detailReservation.disk, limit: detail.diskFreeBytes * .8, format: bytes },
  ] : []
  const operationPanel = operationTask && <div className={`instance-operation host-operation is-${activeTask ? 'active' : 'failed'}`}>
    <div className="instance-operation-copy"><Space wrap><StatusTag value={operationTask.status} /><Typography.Text strong>{translateCode(t, operationTask.kind, 'taskKind')}</Typography.Text><Typography.Text type="secondary">· {translateCode(t, operationTask.stage)}</Typography.Text></Space><Typography.Paragraph type={activeTask ? 'secondary' : 'danger'}>{activeTask ? translateCode(t, operationTask.message, 'taskMessage') : operationTask.errorCode ? translateCode(t, operationTask.errorCode, 'taskError') : operationTask.errorMessage || translateCode(t, operationTask.message, 'taskMessage')}</Typography.Paragraph></div>
    {activeTask && <Progress className="instance-operation-progress" percent={operationTask.progress} status="active" size="small" />}
    <Space className="instance-operation-actions">{failedTask && <Button type="primary" icon={<ReloadOutlined />} loading={actioning === 'retry-task'} disabled={!!actioning && actioning !== 'retry-task'} onClick={() => void retryTask()}>{t('retryTask')}</Button>}<Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewTask')}</Button></Space>
  </div>
  return <><PageHeader title={t('hosts')} description={t('hostsDescription')} actions={<><Button icon={<ReloadOutlined />} onClick={() => void load()}>{t('refresh')}</Button><Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('addHost')}</Button></>} />
    <Card className="host-table-card"><Table rowKey="id" loading={loading} dataSource={items} columns={columns} pagination={false} tableLayout="fixed" locale={{ emptyText: <EmptyState compact action={() => show()} actionLabel={t('addHost')} description={t('noHostsDescription')} /> }} /></Card>
    <Modal title={editing ? t('edit') : t('addHost')} open={open} onCancel={closeEditor} width={760} style={{ top: 32 }} styles={{ body: { maxHeight: 'calc(100vh - 160px)', overflowY: 'auto', paddingRight: 4 } }} destroyOnHidden footer={<div className="workflow-modal-footer"><Button disabled={saving || testing} onClick={closeEditor}>{t('cancel')}</Button><Space>{(!editing || verificationDirty || !fingerprint) && <Button loading={testing} disabled={saving} icon={<SafetyCertificateOutlined />} onClick={() => void test()}>{t('testConnection')}</Button>}<Button type="primary" loading={saving} disabled={testing || !fingerprint} onClick={() => void submit()}>{t('save')}</Button></Space></div>}>
      <Form form={form} layout="vertical" requiredMark={false} autoComplete="off" onValuesChange={invalidateVerification}><Typography.Text className="form-section-label">{t('connectionSettings')}</Typography.Text><div className="form-grid"><Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item><Form.Item name="projectId" label={t('project')}><Select allowClear options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item><Form.Item name="sshAddress" label={t('sshAddress')} rules={[{ required: true }]}><Input autoComplete="off" /></Form.Item><Form.Item name="sshPort" label={t('sshPort')} rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="sshUser" label={t('sshUser')} rules={[{ required: true }]}><Input autoComplete="off" data-1p-ignore data-lpignore="true" /></Form.Item><Form.Item name="authType" label={t('authentication')}><Select options={[{ value: 'private_key', label: t('privateKey') }, { value: 'password', label: t('password') }]} /></Form.Item></div>
        <Form.Item noStyle shouldUpdate={(a, b) => a.authType !== b.authType}>{({ getFieldValue }) => <><Form.Item name="credential" label={getFieldValue('authType') === 'password' ? t('password') : t('privateKey')} rules={!editing || verificationDirty ? [{ required: true }] : []}>{getFieldValue('authType') === 'password' ? <Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /> : <Input.TextArea rows={4} autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={t('privateKeyPlaceholder')} />}</Form.Item>{getFieldValue('authType') === 'private_key' && <Form.Item name="passphrase" label={t('privateKeyPassphrase')}><Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>}</>}</Form.Item>
        <Collapse className="host-advanced" items={[{ key: 'advanced', label: <div><Typography.Text strong>{t('advancedSettings')}</Typography.Text><Typography.Text type="secondary">{t('advancedHostSettingsHint')}</Typography.Text></div>, children: <><div className="form-grid"><Form.Item name="connectionAddress" label={t('databaseConnectionAddress')}><Input placeholder={t('defaultsToSSHAddress')} /></Form.Item><Form.Item name="dataRoot" label={t('managedDataRoot')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="portStart" label={t('portPoolStart')}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item><Form.Item name="portEnd" label={t('portPoolEnd')}><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></div><Card size="small" title={t('proxy')} className="form-section"><div className="form-grid"><Form.Item name="proxyHttp" label="HTTP_PROXY"><Input /></Form.Item><Form.Item name="proxyHttps" label="HTTPS_PROXY"><Input /></Form.Item></div><Form.Item name="proxyNoProxy" label="NO_PROXY"><Input /></Form.Item></Card></> },{ key: 'policies', label: <div><Typography.Text strong>{t('hostPolicies')}</Typography.Text><Typography.Text type="secondary">{t('hostPoliciesHint')}</Typography.Text></div>, children: <div className="host-policy-grid"><Form.Item name="manageDocker" label={t('allowDockerManagement')} valuePropName="checked"><Switch /></Form.Item><Form.Item name="autoRestartDefault" label={t('autoRestart')} valuePropName="checked"><Switch /></Form.Item><Form.Item name="maintenance" label={t('maintenance')} valuePropName="checked"><Switch /></Form.Item></div> }]} />
        {(!editing || verificationDirty) && <div className="verification-section"><Typography.Text className="form-section-label">{t('connectionVerification')}</Typography.Text>{probe ? <Alert type="success" showIcon message={t('connectionVerified')} description={<><Descriptions size="small" column={3} items={[{ key: 'system', label: t('testResultSystem'), children: `${probe.os}/${probe.architecture}` },{ key: 'docker', label: t('testResultDocker'), children: probe.dockerVersion ? `${probe.dockerVersion} / ${probe.composeVersion || '—'}` : t('dockerNotInstalled') },{ key: 'resources', label: t('testResultResources'), children: `${probe.cpuCount} CPU · ${bytes(probe.memoryBytes)} · ${bytes(probe.diskFreeBytes)}` }]} /><Typography.Text code copyable className="fingerprint-value">{fingerprint.split(' ')[0]}</Typography.Text></>} /> : <Alert type={verificationDirty ? 'warning' : 'info'} showIcon message={verificationDirty ? t('connectionChanged') : t('connectionVerificationHint')} />}</div>}
      </Form>
    </Modal>
    <Drawer className="host-detail-drawer" title={detail ? <div className="host-detail-title"><div><CloudServerOutlined /><Typography.Text strong>{detail.name}</Typography.Text></div><StatusTag value={detail.status} /></div> : t('hostDetails')} open={!!detail} onClose={closeDetail} width={780} destroyOnHidden footer={detail && <div className="workflow-drawer-footer"><Popconfirm title={t('delete')} description={t('deleteHostConfirm')} disabled={relatedInstances.length > 0} onConfirm={() => void remove(detail)}><Button danger icon={<DeleteOutlined />} disabled={relatedInstances.length > 0} title={relatedInstances.length ? t('hostDeleteBlocked') : t('delete')}>{t('delete')}</Button></Popconfirm><Space wrap><Button icon={<ReloadOutlined />} loading={actioning === 'probe'} disabled={!!actioning && actioning !== 'probe'} onClick={() => void action(detail, 'probe')}>{t('reprobeHost')}</Button><Button icon={<EditOutlined />} disabled={!!actioning} onClick={() => show(detail)}>{t('edit')}</Button><Dropdown trigger={['click']} menu={{ items: [{ key: 'install', icon: <ToolOutlined />, label: t('installDocker'), disabled: !detail.manageDocker || detail.status === 'offline' || !!actioning },{ key: 'upgrade', label: t('upgradeDocker'), disabled: !detail.manageDocker || detail.status !== 'online' || !!actioning },{ key: 'proxy', label: t('applyDockerProxy'), disabled: !detail.manageDocker || detail.status !== 'online' || detail.os === 'darwin' || !!actioning }], onClick: ({ key }) => void action(detail, key === 'install' ? 'install_docker' : key === 'upgrade' ? 'upgrade_docker' : 'configure_proxy') }}><Button icon={<MoreOutlined />} disabled={!!actioning}>{t('moreActions')}</Button></Dropdown></Space></div>}>
      {detail && <div className="host-detail">
        {detailError && <Alert type="warning" showIcon message={t('hostContextLoadFailed')} description={detailError} action={<Button size="small" onClick={() => void loadHostContext(detail.id)}>{t('retry')}</Button>} />}
        {operationPanel}
        <div className={`host-health-banner is-${detail.status === 'online' ? 'success' : detail.status === 'needs_docker' ? 'warning' : 'error'}`}><div><StatusTag value={detail.status} /><Typography.Text strong>{t('currentHostState')}</Typography.Text></div><Typography.Paragraph>{detail.statusMessage ? translateCode(t, detail.statusMessage, 'statusMessage') : detail.status === 'online' ? t('hostOnlineHint') : detail.status === 'needs_docker' ? t('hostNeedsDockerHint') : t('hostOfflineHint')}</Typography.Paragraph><div className="host-health-facts"><span><Typography.Text type="secondary">{t('lastChecked')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastCheckedAt, i18n.language)}</Typography.Text></span><span><Typography.Text type="secondary">{t('lastSeen')}</Typography.Text><Typography.Text>{formatDateTime(detail.lastSeenAt, i18n.language)}</Typography.Text></span><span><Typography.Text type="secondary">{t('consecutiveFailures')}</Typography.Text><Typography.Text>{detail.consecutiveFailures}</Typography.Text></span></div></div>
        <Card size="small" title={t('schedulingCapacity')} extra={<Typography.Text type="secondary">{t('schedulingCapacityPolicy')}</Typography.Text>}><div className="host-capacity-grid">{capacityItems.map((item) => <div className="host-capacity-item" key={item.key}><div><Typography.Text strong>{item.label}</Typography.Text><Typography.Text type="secondary">{t('capacityRemaining', { value: item.format(Math.max(0, item.limit - item.reserved)) })}</Typography.Text></div><Progress percent={percent(item.reserved, item.limit)} size="small" status={item.reserved > item.limit ? 'exception' : 'normal'} /><Typography.Text type="secondary">{t('capacityReservedOf', { reserved: item.format(item.reserved), limit: item.format(item.limit) })}</Typography.Text></div>)}</div></Card>
        <Card size="small" title={t('managedInstances')} extra={<Typography.Text type="secondary">{t('managedInstanceCount', { count: relatedInstances.length })}</Typography.Text>} className="host-instance-card"><Table size="small" rowKey="id" pagination={false} dataSource={relatedInstances} locale={{ emptyText: <EmptyState compact description={t('noManagedInstances')} /> }} columns={[{ title: t('name'), dataIndex: 'name', render: (value: string, instance: Instance) => <Button type="link" className="description-link" onClick={() => navigate(`/instances/${instance.id}`)}>{value}</Button> },{ title: t('status'), dataIndex: 'status', width: 110, render: (value: string) => <StatusTag value={value} /> },{ title: t('resources'), width: 190, render: (_: unknown, instance: Instance) => `${instance.cpu} CPU · ${bytes(instance.memoryBytes)} · ${bytes(instance.reservedDiskBytes)}` },{ title: t('port'), dataIndex: 'hostPort', width: 85 }]} /></Card>
        <Card size="small" title={t('hostConfiguration')}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'project', label: t('project'), children: projects.find((project) => project.id === detail.projectId)?.name || t('noProject') },{ key: 'ssh', label: t('ssh'), children: `${detail.sshUser}@${detail.sshAddress}:${detail.sshPort}` },{ key: 'connect', label: t('databaseAddress'), children: detail.connectionAddress || detail.sshAddress },{ key: 'system', label: t('system'), children: `${detail.distro || detail.os || '—'} / ${detail.architecture || '—'}` },{ key: 'docker', label: t('docker'), children: detail.dockerVersion || t('dockerNotInstalled') },{ key: 'compose', label: t('compose'), children: detail.composeVersion || '—' },{ key: 'root', label: t('dataRoot'), children: <Typography.Text code>{detail.dataRoot}</Typography.Text> },{ key: 'ports', label: t('portPool'), children: `${detail.portStart}–${detail.portEnd}` },{ key: 'usedPorts', label: t('usedPorts'), children: detailReservation.ports.length ? detailReservation.ports.sort((a, b) => a - b).join(', ') : '—' },{ key: 'policies', label: t('hostPolicies'), children: <Space wrap><Tag color={detail.manageDocker ? 'blue' : undefined}>{t('dockerManagement')}: {detail.manageDocker ? t('enabled') : t('disabled')}</Tag><Tag color={detail.autoRestartDefault ? 'green' : undefined}>{t('autoRestart')}: {detail.autoRestartDefault ? t('enabled') : t('disabled')}</Tag><Tag color={detail.maintenance ? 'orange' : undefined}>{t('maintenance')}: {detail.maintenance ? t('enabled') : t('disabled')}</Tag></Space>, span: 2 },{ key: 'labels', label: t('labels'), children: Object.keys(detail.labels || {}).length ? <Space wrap>{Object.entries(detail.labels).map(([key, value]) => <Tag key={key}>{key}={value}</Tag>)}</Space> : '—', span: 2 }]} /></Card>
      </div>}
    </Drawer>
  </>
}
