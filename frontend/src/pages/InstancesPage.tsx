import { CheckCircleOutlined, CloudServerOutlined, CloseCircleOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, LeftOutlined, LockOutlined, MoreOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RocketOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, Descriptions, Drawer, Dropdown, Form, Input, InputNumber, Modal, Progress, Radio, Row, Select, Space, Steps, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import appI18n from '../i18n'
import { api, errorMessage } from '../lib/api'
import { hostCanAccept, hostHeadroomScore, remainingAfterDeployment, reservationForHost } from '../lib/host-capacity'
import { imageRegistryHost, registryMatchesImage } from '../lib/image-source'
import { instanceQuickAction } from '../lib/instance-actions'
import { translateCode } from '../lib/localization'
import { selectRecoveryTasks } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import type { DatabaseTemplate, Host, ImageArtifact, Instance, Project, Registry, Task } from '../lib/types'
import { bytes } from '../lib/types'

type ImageSource = 'public' | 'registry' | 'offline'

interface CreateValues { name: string; projectId?: string; environment: string; templateVersionId: string; hostId?: string; cpu: number; memoryGiB: number; diskGiB: number; hostPort?: number; bindAddress: string; username?: string; password?: string; databaseName?: string; autoRestart: boolean; imageSource: ImageSource; imageArtifactId?: string; registryId?: string; labels?: string; extraEnvironment?: string }

export function InstancesPage() {
  const { t } = useTranslation(); const { message, modal } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const [items, setItems] = useState<Instance[]>([]); const [templates, setTemplates] = useState<DatabaseTemplate[]>([]); const [hosts, setHosts] = useState<Host[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [images, setImages] = useState<ImageArtifact[]>([]); const [registries, setRegistries] = useState<Registry[]>([]); const [loading, setLoading] = useState(true); const [creating, setCreating] = useState(false); const [createDraftDirty, setCreateDraftDirty] = useState(false); const [createError, setCreateError] = useState(''); const [actioning, setActioning] = useState(''); const [drawer, setDrawer] = useState(false); const [step, setStep] = useState(0); const [search, setSearch] = useState(''); const [projectFilter, setProjectFilter] = useState(''); const [environmentFilter, setEnvironmentFilter] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [form] = Form.useForm<CreateValues>()
  const load = useCallback(() => Promise.all([api<{ items: Instance[] }>('/instances'), api<{ items: DatabaseTemplate[] }>('/templates'), api<{ items: Host[] }>('/hosts'), api<{ items: Project[] }>('/projects'), api<{ items: ImageArtifact[] }>('/images'), api<{ items: Registry[] }>('/registries')]).then(([i, tpls, h, p, im, r]) => { setItems(i.items); setTemplates(tpls.items); setHosts(h.items); setProjects(p.items); setImages(im.items); setRegistries(r.items) }).catch((e) => message.error(errorMessage(e))).finally(() => setLoading(false)), [message])
  const hasOnlineHost = hosts.some((host) => host.status === 'online' && !host.maintenance)
  const createRequested = params.get('create') === '1'
  const requestedTemplateID = params.get('template')
  const requestedTemplateAvailable = !!requestedTemplateID && templates.some((template) => template.versions.some((version) => version.id === requestedTemplateID))
  const createIntent = useCallback(() => {
    return `/instances?create=1${requestedTemplateID ? `&template=${encodeURIComponent(requestedTemplateID)}` : ''}`
  }, [requestedTemplateID])
  const addRequiredHost = useCallback(() => navigate(`/hosts?create=1&returnTo=${encodeURIComponent(createIntent())}`), [createIntent, navigate])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (loading || !createRequested) return
    if (!hasOnlineHost) { addRequiredHost(); return }
    setStep(requestedTemplateAvailable ? 1 : 0)
    setCreateError('')
    setCreateDraftDirty(false)
    form.resetFields()
    form.setFieldsValue({ environment: 'development', bindAddress: '0.0.0.0', autoRestart: true, imageSource: 'public', templateVersionId: requestedTemplateAvailable ? requestedTemplateID : undefined })
    setDrawer(true)
  }, [addRequiredHost, createRequested, form, hasOnlineHost, loading, requestedTemplateAvailable, requestedTemplateID])
  const selectedVersionID = Form.useWatch('templateVersionId', { form, preserve: true })
  const selectedHostID = Form.useWatch('hostId', { form, preserve: true })
  const selectedRegistryID = Form.useWatch('registryId', { form, preserve: true })
  const imageSource = Form.useWatch('imageSource', { form, preserve: true }) || 'public'
  const requestedCPU = Form.useWatch('cpu', { form, preserve: true })
  const requestedMemoryGiB = Form.useWatch('memoryGiB', { form, preserve: true })
  const requestedDiskGiB = Form.useWatch('diskGiB', { form, preserve: true })
  const requestedHostPort = Form.useWatch('hostPort', { form, preserve: true })
  const selected = useMemo(() => { for (const item of templates) for (const version of item.versions) if (version.id === selectedVersionID) return { template: item, version }; return undefined }, [templates, selectedVersionID])
  const compatibleHosts = useMemo(() => hosts.filter((host) => host.status === 'online' && !host.maintenance && (!selected || selected.version.architectures.includes(host.architecture || ''))), [hosts, selected])
  const selectedHost = compatibleHosts.find((host) => host.id === selectedHostID)
  const resourceRequest = useMemo(() => ({ cpu: requestedCPU || 0, memory: Math.round((requestedMemoryGiB || 0) * 1024 ** 3), disk: Math.round((requestedDiskGiB || 0) * 1024 ** 3), port: requestedHostPort || undefined }), [requestedCPU, requestedDiskGiB, requestedHostPort, requestedMemoryGiB])
  const resourceRequestReady = resourceRequest.cpu > 0 && resourceRequest.memory > 0 && resourceRequest.disk > 0
  const resourceHostScope = useMemo(() => selectedHost ? [selectedHost] : compatibleHosts, [compatibleHosts, selectedHost])
  const capacityCandidates = useMemo(() => resourceRequestReady ? resourceHostScope.filter((host) => hostCanAccept(host, reservationForHost(items, host.id), resourceRequest)) : resourceHostScope, [items, resourceHostScope, resourceRequest, resourceRequestReady])
  const capacityPreviewHost = useMemo(() => [...capacityCandidates].sort((a, b) => hostHeadroomScore(b, reservationForHost(items, b.id)) - hostHeadroomScore(a, reservationForHost(items, a.id)))[0], [capacityCandidates, items])
  const capacityRemaining = capacityPreviewHost && resourceRequestReady ? remainingAfterDeployment(capacityPreviewHost, reservationForHost(items, capacityPreviewHost.id), resourceRequest) : undefined
  const compatibleImages = useMemo(() => images.filter((item) => item.status === 'ready' && !!selected && item.imageRefs.includes(selected.version.imageReference) && item.architectures.some((architecture) => selected.version.architectures.includes(architecture))), [images, selected])
  const compatibleRegistries = useMemo(() => registries.filter((registry) => !!selected && registryMatchesImage(registry.url, selected.version.imageReference)), [registries, selected])
  const selectedRegistry = compatibleRegistries.find((registry) => registry.id === selectedRegistryID)
  useEffect(() => {
    if (!selected) return
    const manifest = selected.version.manifest as { username?: string; database?: string }
    form.setFieldsValue({ cpu: selected.version.minCpu, memoryGiB: selected.version.minMemoryBytes / 1024 ** 3, diskGiB: selected.version.minDiskBytes / 1024 ** 3, username: manifest.username, databaseName: manifest.database })
    if (selectedHostID && !compatibleHosts.some((host) => host.id === selectedHostID)) form.setFieldValue('hostId', undefined)
    const imageArtifactID = form.getFieldValue('imageArtifactId')
    if (imageArtifactID && !compatibleImages.some((item) => item.id === imageArtifactID)) form.setFieldValue('imageArtifactId', undefined)
    const registryID = form.getFieldValue('registryId')
    if (registryID && !compatibleRegistries.some((registry) => registry.id === registryID)) form.setFieldValue('registryId', undefined)
  }, [compatibleHosts, compatibleImages, compatibleRegistries, form, selected, selectedHostID])
  const openCreate = () => { if (!hasOnlineHost) { addRequiredHost(); return } setDrawer(true); setStep(0); setCreateError(''); setCreateDraftDirty(false); form.resetFields(); form.setFieldsValue({ environment: 'development', bindAddress: '0.0.0.0', autoRestart: true, imageSource: 'public' }) }
  const finishCloseCreate = () => { setDrawer(false); setParams({}); setStep(0); setCreateError(''); setCreateDraftDirty(false); form.resetFields() }
  const closeCreate = () => {
    if (creating) return
    if (!createDraftDirty) { finishCloseCreate(); return }
    modal.confirm({
      title: t('discardInstanceDraftTitle'),
      content: t('discardInstanceDraftHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseCreate,
    })
  }
  const next = async () => {
    const fields: Array<keyof CreateValues> = step === 0 ? ['templateVersionId'] : step === 1 ? ['name', 'environment'] : step === 2 ? ['cpu', 'memoryGiB', 'diskGiB', 'bindAddress'] : step === 3 ? ['extraEnvironment', ...(imageSource === 'registry' ? ['registryId' as const] : imageSource === 'offline' ? ['imageArtifactId' as const] : [])] : []
    try {
      await form.validateFields(fields)
      if (step === 0 && compatibleHosts.length === 0) return
      if (step === 2 && capacityCandidates.length === 0) return
      setCreateError('')
      setStep(Math.min(step + 1, 4))
    } catch { /* form marks errors */ }
  }
  const create = async () => {
    try {
      setCreating(true)
      setCreateError('')
      await form.validateFields()
      const values = form.getFieldsValue(true) as CreateValues
      const labels: Record<string, string> = {}
      values.labels?.split(',').forEach((part) => { const separator = part.indexOf('='); const key = separator >= 0 ? part.slice(0, separator) : part; const value = separator >= 0 ? part.slice(separator + 1) : ''; if (key.trim()) labels[key.trim()] = value.trim() || 'true' })
      let extraEnvironment: Record<string, string> = {}
      if (values.extraEnvironment?.trim()) extraEnvironment = JSON.parse(values.extraEnvironment)
      const payload = { name: values.name, projectId: values.projectId || null, environment: values.environment, templateVersionId: values.templateVersionId, hostId: values.hostId || null, cpu: values.cpu, memoryBytes: Math.round(values.memoryGiB * 1024 ** 3), diskBytes: Math.round(values.diskGiB * 1024 ** 3), hostPort: values.hostPort || 0, bindAddress: values.bindAddress, username: values.username || '', password: values.password || '', databaseName: values.databaseName || '', autoRestart: values.autoRestart, imageArtifactId: values.imageSource === 'offline' ? values.imageArtifactId || null : null, registryId: values.imageSource === 'registry' ? values.registryId || null : null, labels, extraEnvironment }
      const result = await api<{ instance: Instance; task: Task }>('/instances', { method: 'POST', body: payload })
      notifyTask(result.task)
      finishCloseCreate()
      navigate(`/instances/${result.instance.id}`)
    } catch (e) {
      if (e instanceof Error) setCreateError(errorMessage(e))
    } finally { setCreating(false) }
  }
  const quickAction = async (item: Instance, action: string) => { const key = `${item.id}:${action}`; try { setActioning(key); const task = await api<Task>(`/instances/${item.id}/actions/${action}`, { method: 'POST', body: {} }); notifyTask(task); navigate(`/instances/${item.id}`) } catch (e) { message.error(errorMessage(e)) } finally { setActioning('') } }
  const columns = [
    { title: t('name'), dataIndex: 'name', width: 145, ellipsis: true, render: (value: string, item: Instance) => <Button type="link" className="instance-table-name" title={value} onClick={() => navigate(`/instances/${item.id}`)}>{value}</Button> },
    { title: t('template'), width: 170, ellipsis: true, render: (_: unknown, item: Instance) => <Space><DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" /><span>{item.templateName} <Typography.Text type="secondary">{item.templateVersion}</Typography.Text></span></Space> },
    { title: t('status'), dataIndex: 'status', width: 95, render: (value: string) => <StatusTag value={value} /> },
    { title: t('host'), width: 160, ellipsis: true, render: (_: unknown, item: Instance) => <><Typography.Text>{item.hostName}</Typography.Text><br /><Typography.Text type="secondary">{item.connectionAddress}:{item.hostPort}</Typography.Text></> },
    { title: t('resources'), width: 205, render: (_: unknown, item: Instance) => `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },
    { title: t('environment'), dataIndex: 'environment', width: 105, render: (value: string) => <Tag>{translateCode(t, value)}</Tag> },
    { title: '', align: 'right' as const, fixed: 'right' as const, width: 88, render: (_: unknown, item: Instance) => { const action = instanceQuickAction(item.status); const key = action ? `${item.id}:${action}` : ''; return <Space size={2}>{action && <Button type="text" loading={actioning === key} disabled={!!actioning && actioning !== key} aria-label={t(action)} title={t(action)} icon={action === 'stop' ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={() => void quickAction(item, action)} />}<Button type="text" aria-label={t('details')} title={t('details')} icon={<MoreOutlined />} onClick={() => navigate(`/instances/${item.id}`)} /></Space> } },
  ]
  const versionOptions = templates.flatMap((item) => item.versions.map((version) => ({ value: version.id, searchText: `${item.name} ${item.nameZh} ${version.version}`, label: `${item.name} ${version.version}`, template: item, version })))
  const filteredItems = useMemo(() => items.filter((item) => (!projectFilter || item.projectId === projectFilter) && (!environmentFilter || item.environment === environmentFilter) && (!statusFilter || item.status === statusFilter) && `${item.name} ${item.templateName} ${item.hostName} ${JSON.stringify(item.labels)}`.toLowerCase().includes(search.toLowerCase())), [items, projectFilter, environmentFilter, statusFilter, search])
  const hasFilters = !!(search || projectFilter || environmentFilter || statusFilter)
  const clearFilters = () => { setSearch(''); setProjectFilter(''); setEnvironmentFilter(''); setStatusFilter('') }
  const emptyAction = hasFilters ? clearFilters : openCreate
  const emptyActionLabel = hasFilters ? t('clearFilters') : hasOnlineHost ? t('createInstance') : t('addHost')
  const emptyDescription = hasFilters ? t('instancesFilteredEmptyDescription') : t('instancesEmptyDescription')
  return <><PageHeader title={t('instances')} description={t('instancesDescription')} actions={<><Button icon={<ReloadOutlined />} onClick={() => void load()}>{t('refresh')}</Button><Button type="primary" loading={loading} icon={hasOnlineHost ? <PlusOutlined /> : <CloudServerOutlined />} onClick={openCreate}>{hasOnlineHost ? t('createInstance') : t('addHost')}</Button></>} />
    <Card className="table-filter-card"><Space wrap><Input.Search allowClear value={search} aria-label={t('instancesSearchLabel')} placeholder={t('instancesSearchPlaceholder')} onChange={(event) => setSearch(event.target.value)} style={{ width: 280 }} /><Select value={projectFilter} onChange={setProjectFilter} style={{ width: 170 }} options={[{ value: '', label: t('allProjects') }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /><Select value={environmentFilter} onChange={setEnvironmentFilter} style={{ width: 160 }} options={[{ value: '', label: t('allEnvironments') }, ...['development', 'testing', 'staging', 'production'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Select value={statusFilter} onChange={setStatusFilter} style={{ width: 150 }} options={[{ value: '', label: t('allStatuses') }, ...['provisioning', 'running', 'stopped', 'degraded', 'failed'].map((value) => ({ value, label: translateCode(t, value) }))]} /></Space></Card><Card className="instance-table-card"><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} scroll={{ x: 968 }} locale={{ emptyText: <EmptyState compact action={emptyAction} actionLabel={emptyActionLabel} description={emptyDescription} /> }} /></Card>
    <Drawer title={t('createInstance')} open={drawer} onClose={closeCreate} closable={!creating} maskClosable={!creating} width={720} destroyOnClose footer={<div className="workflow-drawer-footer"><Button disabled={creating} onClick={closeCreate}>{t('cancel')}</Button><Space><Button icon={<LeftOutlined />} disabled={creating || step === 0} onClick={() => { setCreateError(''); setStep((value) => Math.max(0, value - 1)) }}>{t('previous')}</Button><Button type="primary" loading={creating} disabled={(step === 0 && !!selected && compatibleHosts.length === 0) || (step === 2 && resourceRequestReady && capacityCandidates.length === 0)} onClick={step === 4 ? () => void create() : () => void next()}>{step === 4 ? t('create') : t('next')}</Button></Space></div>}><Steps current={step} size="small" responsive={false} items={[{ title: t('template') }, { title: t('basicInfo') }, { title: t('resources') }, { title: t('options') }, { title: t('confirm') }]} /><Form form={form} layout="vertical" requiredMark={false} className="wizard-form" onValuesChange={() => setCreateDraftDirty(true)}>
      {step === 0 && <><Form.Item name="templateVersionId" label={`${t('template')} / ${t('version')}`} rules={[{ required: true }]}><Select showSearch optionFilterProp="searchText" options={versionOptions} size="large" optionRender={(option) => <Space><DatabaseIcon slug={option.data.template.slug} name={option.data.template.name} size="small" /><span>{option.label}</span></Space>} labelRender={({ value, label }) => { const option = versionOptions.find((item) => item.value === value); return option ? <Space><DatabaseIcon slug={option.template.slug} name={option.template.name} size="small" /><span>{option.label}</span></Space> : label }} /></Form.Item>{selected && <Card><Space align="start"><DatabaseIcon slug={selected.template.slug} name={selected.template.name} /><div><Typography.Title level={4}>{selected.template.name}</Typography.Title><Typography.Paragraph type="secondary">{t(`templateDescription_${selected.template.slug}`, { defaultValue: selected.template.description })}</Typography.Paragraph><Space wrap><StatusTag value={selected.template.tier} />{selected.version.architectures.map((a) => <Tag key={a}>{a}</Tag>)}<Tag>{selected.version.imageReference}</Tag></Space></div></Space></Card>}{selected && compatibleHosts.length === 0 && <Alert className="wizard-readiness-alert" type="warning" showIcon message={t('noCompatibleHosts')} description={t('noCompatibleHostsHint', { architectures: selected.version.architectures.join(' / ') })} action={<Button size="small" onClick={addRequiredHost}>{t('addHost')}</Button>} />}</>}
      {step === 1 && <><Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input size="large" autoFocus /></Form.Item><div className="form-grid"><Form.Item name="projectId" label={t('project')}><Select allowClear options={projects.map((p) => ({ value: p.id, label: p.name }))} /></Form.Item><Form.Item name="environment" label={t('environment')} rules={[{ required: true }]}><Select options={['development', 'testing', 'staging', 'production'].map((v) => ({ value: v, label: translateCode(t, v) }))} /></Form.Item></div><Form.Item name="labels" label={t('labels')}><Input placeholder={t('labelsPlaceholder')} /></Form.Item><Form.Item name="hostId" label={t('host')} tooltip={t('autoHostTooltip')}><Select allowClear placeholder={t('autoSelect')} options={compatibleHosts.map((host) => ({ value: host.id, label: `${host.name} · ${host.architecture} · ${host.cpuCount} CPU / ${bytes(host.memoryBytes)} · ${bytes(host.diskFreeBytes)} ${t('available')}` }))} /></Form.Item><Alert type="info" showIcon message={selectedHost ? t('selectedHostReady', { name: selectedHost.name }) : t('automaticHostSelection', { count: compatibleHosts.length })} description={selectedHost ? `${selectedHost.connectionAddress || selectedHost.sshAddress} · ${selectedHost.portStart}–${selectedHost.portEnd}` : t('automaticHostSelectionHint')} /></>}
      {step === 2 && <><Row gutter={16}><Col span={8}><Form.Item name="cpu" label={t('cpu')} rules={[{ required: true }]}><InputNumber min={selected?.version.minCpu ?? .25} step={.25} style={{ width: '100%' }} /></Form.Item></Col><Col span={8}><Form.Item name="memoryGiB" label={`${t('memory')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minMemoryBytes ?? 0) / 1024 ** 3} step={.5} style={{ width: '100%' }} /></Form.Item></Col><Col span={8}><Form.Item name="diskGiB" label={`${t('disk')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minDiskBytes ?? 0) / 1024 ** 3} style={{ width: '100%' }} /></Form.Item></Col></Row><div className="form-grid"><Form.Item name="hostPort" label={`${t('port')} (${t('optional')})`}><InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder={t('autoAllocate')} /></Form.Item><Form.Item name="bindAddress" label={t('bindAddress')} rules={[{ required: true }]}><Input /></Form.Item></div><Typography.Paragraph type="secondary">{t('diskReservationHint')}</Typography.Paragraph>{resourceRequestReady && <Alert className="wizard-capacity-alert" type={capacityCandidates.length ? 'success' : 'warning'} showIcon message={capacityCandidates.length ? selectedHost ? t('selectedHostCapacityReady', { name: selectedHost.name }) : t('automaticHostCapacityReady', { fit: capacityCandidates.length, total: resourceHostScope.length }) : t('hostCapacityUnavailable')} description={capacityRemaining && capacityPreviewHost ? t(requestedHostPort ? 'hostCapacityPreviewWithPort' : 'hostCapacityPreview', { name: capacityPreviewHost.name, cpu: capacityRemaining.cpu.toFixed(capacityRemaining.cpu % 1 ? 1 : 0), memory: bytes(capacityRemaining.memory), disk: bytes(capacityRemaining.disk), port: requestedHostPort }) : t('hostCapacityUnavailableHint')} />}</>}
      {step === 3 && <><div className="form-grid"><Form.Item name="username" label={t('username')}><Input /></Form.Item><Form.Item name="databaseName" label={t('databaseName')}><Input /></Form.Item></div><Form.Item name="password" label={t('password')} tooltip={t('passwordGenerateHint')}><Input.Password placeholder={t('automaticallyGenerated')} /></Form.Item><Form.Item name="imageSource" label={t('imageSource')}><Radio.Group optionType="button" buttonStyle="solid" options={[{ value: 'public', label: t('publicRegistry') }, { value: 'registry', label: t('configuredRegistry') }, { value: 'offline', label: t('offlineImage') }]} onChange={() => { form.setFieldsValue({ imageArtifactId: undefined, registryId: undefined }); setCreateError('') }} /></Form.Item>{imageSource === 'public' && <Alert type="info" showIcon message={t('pullTemplateImage')} description={selected?.version.imageReference} />}{imageSource === 'registry' && <><Form.Item name="registryId" label={t('registry')} rules={[{ required: true }]}><Select placeholder={t('selectRegistryForHost', { host: selected ? imageRegistryHost(selected.version.imageReference) : '—' })} options={compatibleRegistries.map((registry) => ({ value: registry.id, disabled: ['offline', 'degraded'].includes(registry.status), label: <Space><span>{registry.name}</span><StatusTag value={registry.status} /></Space> }))} /></Form.Item>{compatibleRegistries.length === 0 ? <Alert type="warning" showIcon message={t('noMatchingRegistries')} description={t('noMatchingRegistriesHint', { host: selected ? imageRegistryHost(selected.version.imageReference) : '—' })} action={<Button size="small" onClick={() => navigate('/images?tab=registries')}>{t('addRegistry')}</Button>} /> : selectedRegistry && <Alert type={selectedRegistry.status === 'online' ? 'success' : 'info'} showIcon message={t('registryMatchesImageSource', { host: imageRegistryHost(selected?.version.imageReference || '') })} description={selectedRegistry.statusMessage ? t(selectedRegistry.statusMessage) : t('registryWillBeVerifiedOnTarget')} />}</>}{imageSource === 'offline' && <><Form.Item name="imageArtifactId" label={t('offlineImage')} rules={[{ required: true }]}><Select placeholder={t('selectCompatibleImage')} options={compatibleImages.map((item) => ({ value: item.id, label: `${item.name} · ${bytes(item.sizeBytes)} · ${item.architectures.join(' / ')}` }))} /></Form.Item>{compatibleImages.length === 0 && <Alert type="warning" showIcon message={t('noCompatibleImages')} description={t('noCompatibleImagesHint', { image: selected?.version.imageReference || '—' })} action={<Button size="small" onClick={() => navigate('/images')}>{t('uploadImage')}</Button>} />}</>}<Form.Item name="autoRestart" label={t('autoRestart')} valuePropName="checked"><Switch /></Form.Item><Form.Item name="extraEnvironment" label={t('extraEnvironment')} rules={[{ validator: (_, value?: string) => { if (!value?.trim()) return Promise.resolve(); try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((item) => typeof item === 'string') ? Promise.resolve() : Promise.reject(new Error(t('invalidJSONObject'))) } catch { return Promise.reject(new Error(t('invalidJSONObject'))) } } }]}><Input.TextArea rows={5} placeholder={'{\n  "TZ": "Asia/Shanghai"\n}'} /></Form.Item></>}
      {step === 4 && <div className="create-review">
        <div className="create-review-header">
          <DatabaseIcon slug={selected?.template.slug || 'database'} name={selected?.template.name || t('database')} />
          <div>
            <Typography.Title level={4}>{form.getFieldValue('name')}</Typography.Title>
            <Space size={[6, 6]} wrap>
              <Typography.Text type="secondary">{selected ? `${selected.template.name} ${selected.version.version}` : '—'}</Typography.Text>
              <Tag>{translateCode(t, form.getFieldValue('environment'))}</Tag>
              {selected && <StatusTag value={selected.template.tier} />}
            </Space>
          </div>
          <CheckCircleOutlined className="create-review-ready-icon" />
        </div>
        <div className="create-review-grid">
          <Card size="small" className="create-review-card" title={t('deploymentTarget')}>
            <Descriptions column={1} colon={false} items={[
              { key: 'host', label: t('host'), children: selectedHost?.name || (capacityPreviewHost ? t('recommendedHost', { name: capacityPreviewHost.name }) : t('autoSelectWithCapacity', { count: capacityCandidates.length })) },
              { key: 'project', label: t('project'), children: projects.find((project) => project.id === form.getFieldValue('projectId'))?.name || t('noProject') },
              { key: 'resources', label: t('resources'), children: `${form.getFieldValue('cpu')} CPU · ${form.getFieldValue('memoryGiB')} GiB · ${form.getFieldValue('diskGiB')} GiB` },
              { key: 'network', label: `${t('bindAddress')} / ${t('port')}`, children: `${form.getFieldValue('bindAddress')}:${form.getFieldValue('hostPort') || t('autoAllocate')}` },
            ]} />
          </Card>
          <Card size="small" className="create-review-card" title={t('databaseAccess')}>
            <Descriptions column={1} colon={false} items={[
              { key: 'database', label: t('databaseName'), children: form.getFieldValue('databaseName') || '—' },
              { key: 'username', label: t('username'), children: form.getFieldValue('username') || '—' },
              { key: 'password', label: t('password'), children: form.getFieldValue('password') ? t('customPasswordConfigured') : t('passwordGeneratedAfterCreate') },
              { key: 'image', label: t('imageSource'), children: imageSource === 'offline' ? images.find((item) => item.id === form.getFieldValue('imageArtifactId'))?.name || '—' : imageSource === 'registry' ? registries.find((registry) => registry.id === form.getFieldValue('registryId'))?.name || '—' : t('publicRegistry') },
            ]} />
          </Card>
        </div>
        <Card size="small" className="create-review-card create-review-options" title={t('deploymentOptions')}>
          <Descriptions column={2} colon={false} items={[
            { key: 'restart', label: t('autoRestart'), children: form.getFieldValue('autoRestart') ? t('enabled') : t('disabled') },
            { key: 'labels', label: t('labels'), children: form.getFieldValue('labels') || '—' },
            { key: 'environmentVariables', label: t('extraEnvironment'), span: 2, children: <Typography.Text code>{form.getFieldValue('extraEnvironment') || '—'}</Typography.Text> },
          ]} />
        </Card>
        <Alert className="create-review-alert" type="info" showIcon message={t('configurationReady')} description={t('createTaskHint')} />
        {createError && <Alert className="wizard-submit-error" type="error" showIcon message={t('instanceCreateFailed')} description={createError} />}
      </div>}
    </Form></Drawer>
  </>
}

interface Metric { collectedAt: string; cpuPercent: number; memoryBytes: number; memoryPercent: number; diskUsedBytes: number; diskTotalBytes: number }
interface Connection { address: string; port: number; username: string; password: string; database: string; uri: string; jdbc?: string }

function responseError(text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    return parsed.error?.code ? appI18n.t(`error_${parsed.error.code}`, { defaultValue: parsed.error.message || text }) : parsed.error?.message || text
  } catch {
    return text
  }
}

function environmentFile(connection: Connection) {
  const value = (input: string) => JSON.stringify(input)
  return [
    `DB_HOST=${value(connection.address)}`,
    `DB_PORT=${connection.port}`,
    `DB_USER=${value(connection.username)}`,
    `DB_PASSWORD=${value(connection.password)}`,
    `DB_NAME=${value(connection.database)}`,
    `DATABASE_URL=${value(connection.uri)}`,
  ].join('\n')
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch { /* fall back for browsers that deny the async clipboard API */ }
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

export function InstanceDetailPage() {
  const { id = '' } = useParams(); const { t, i18n } = useTranslation(); const { message } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [detailParams, setDetailParams] = useSearchParams(); const requestedTab = detailParams.get('tab'); const [item, setItem] = useState<Instance | null>(null); const [pageLoading, setPageLoading] = useState(true); const [pageError, setPageError] = useState(''); const [connection, setConnection] = useState<Connection | null>(null); const [connectionLoading, setConnectionLoading] = useState(false); const [logs, setLogs] = useState(''); const [logsLoading, setLogsLoading] = useState(false); const [logsError, setLogsError] = useState(''); const [logsUpdatedAt, setLogsUpdatedAt] = useState<Date>(); const [logTail, setLogTail] = useState(1000); const [logsAutoRefresh, setLogsAutoRefresh] = useState(true); const [metrics, setMetrics] = useState<Metric[]>([]); const [metricsLoading, setMetricsLoading] = useState(false); const [metricsError, setMetricsError] = useState(''); const [metricHours, setMetricHours] = useState(24); const [templates, setTemplates] = useState<DatabaseTemplate[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [tasks, setTasks] = useState<Task[]>([]); const [deleteOpen, setDeleteOpen] = useState(false); const [confirm, setConfirm] = useState(''); const [upgradeOpen, setUpgradeOpen] = useState(false); const [upgradeVersion, setUpgradeVersion] = useState<string>(); const [editOpen, setEditOpen] = useState(false); const [editSaving, setEditSaving] = useState(false); const [actioning, setActioning] = useState(''); const [activeTab, setActiveTab] = useState(['overview', 'connection', 'logs', 'metrics'].includes(requestedTab || '') ? requestedTab! : 'overview'); const [editForm] = Form.useForm()
  const load = useCallback(async () => {
    try {
      const instance = await api<Instance>(`/instances/${id}`)
      setItem(instance)
      const [catalog, projectList, taskList] = await Promise.allSettled([
        api<{ items: DatabaseTemplate[] }>('/templates'),
        api<{ items: Project[] }>('/projects'),
        api<{ items: Task[] }>(`/tasks?resourceType=instance&resourceId=${encodeURIComponent(id)}`),
      ])
      if (catalog.status === 'fulfilled') setTemplates(catalog.value.items)
      if (projectList.status === 'fulfilled') setProjects(projectList.value.items)
      if (taskList.status === 'fulfilled') setTasks(taskList.value.items)
      const failedRequest = [catalog, projectList, taskList].find((result) => result.status === 'rejected')
      setPageError(failedRequest?.status === 'rejected' ? errorMessage(failedRequest.reason) : '')
    } catch (error) { setPageError(errorMessage(error)) } finally { setPageLoading(false) }
  }, [id])
  useEffect(() => { setItem(null); setPageLoading(true); void load(); const timer = window.setInterval(() => void load(), 10000); return () => clearInterval(timer) }, [load])
  useEffect(() => { if (requestedTab && ['overview', 'connection', 'logs', 'metrics'].includes(requestedTab)) setActiveTab(requestedTab) }, [requestedTab])
  const changeTab = (tab: string) => { const next = new URLSearchParams(detailParams); if (tab === 'overview') next.delete('tab'); else next.set('tab', tab); setActiveTab(tab); setDetailParams(next, { replace: true }) }
  const run = async (action: string, body: Record<string, unknown> = {}) => { try { setActioning(action); const task = await api<Task>(`/instances/${id}/actions/${action}`, { method: 'POST', body }); setTasks((current) => [task, ...current]); notifyTask(task); setDeleteOpen(false); setUpgradeOpen(false); if (action === 'delete') navigate('/instances'); else await load() } catch (e) { message.error(errorMessage(e)) } finally { setActioning('') } }
  const loadConnection = async () => { try { setConnectionLoading(true); setConnection(await api<Connection>(`/instances/${id}/connection`)) } catch (e) { message.error(errorMessage(e)) } finally { setConnectionLoading(false) } }
  const loadLogs = useCallback(async () => { try { setLogsLoading(true); setLogsError(''); const response = await fetch(`/api/v1/instances/${id}/logs?tail=${logTail}`, { credentials: 'same-origin' }); const text = await response.text(); if (!response.ok) throw new Error(responseError(text)); setLogs(text); setLogsUpdatedAt(new Date()) } catch (error) { setLogsError(errorMessage(error)) } finally { setLogsLoading(false) } }, [id, logTail])
  const loadMetrics = useCallback(async () => { try { setMetricsLoading(true); setMetricsError(''); const response = await api<{ items: Metric[] }>(`/instances/${id}/metrics?hours=${metricHours}`); setMetrics(response.items) } catch (error) { setMetricsError(errorMessage(error)) } finally { setMetricsLoading(false) } }, [id, metricHours])
  useEffect(() => { if (activeTab !== 'logs' && activeTab !== 'metrics') return; const refresh = () => activeTab === 'logs' ? loadLogs() : loadMetrics(); void refresh(); if (activeTab === 'logs' && !logsAutoRefresh) return; const timer = window.setInterval(() => void refresh(), activeTab === 'logs' ? 5000 : 30000); return () => clearInterval(timer) }, [activeTab, loadLogs, loadMetrics, logsAutoRefresh])
  useEffect(() => { if (activeTab !== 'connection') setConnection(null) }, [activeTab])
  const showEdit = () => { if (!item) return; editForm.resetFields(); editForm.setFieldsValue({ name: item.name, projectId: item.projectId, environment: item.environment, labels: Object.entries(item.labels || {}).map(([key, value]) => `${key}=${value}`).join(', '), autoRestart: item.autoRestart }); setEditOpen(true) }
  const showDelete = () => { setConfirm(''); setDeleteOpen(true) }
  const showUpgrade = () => { setUpgradeVersion(undefined); setUpgradeOpen(true) }
  const saveEdit = async () => { try { setEditSaving(true); const values = await editForm.validateFields(); const labels: Record<string, string> = {}; String(values.labels || '').split(',').forEach((part) => { const separator = part.indexOf('='); const key = separator >= 0 ? part.slice(0, separator) : part; const value = separator >= 0 ? part.slice(separator + 1) : ''; if (key.trim()) labels[key.trim()] = value.trim() || 'true' }); await api(`/instances/${id}`, { method: 'PATCH', body: { name: values.name, projectId: values.projectId || null, environment: values.environment, labels, autoRestart: !!values.autoRestart } }); message.success(t('saved')); setEditOpen(false); await load() } catch (error) { if (error instanceof Error) message.error(errorMessage(error)) } finally { setEditSaving(false) } }
  if (!item) return <Card loading={pageLoading}><EmptyState compact action={() => { setPageLoading(true); void load() }} actionLabel={t('retry')} description={pageError || t('instanceLoadFailed')} /></Card>
  const currentTemplate = templates.find((tpl) => tpl.slug === item.templateSlug); const upgradeOptions = currentTemplate?.versions.filter((v) => v.id !== item.templateVersionId).map((v) => ({ value: v.id, label: v.version })) ?? []
  const project = projects.find((candidate) => candidate.id === item.projectId)
  const { activeTask, failedTask, operationTask } = selectRecoveryTasks(tasks, ['failed', 'degraded'].includes(item.status))
  const retryTask = async () => {
    if (!failedTask) return
    try {
      setActioning('retry-task')
      const retried = await api<Task>(`/tasks/${failedTask.id}/retry`, { method: 'POST', body: {} })
      setTasks((current) => [retried, ...current])
      notifyTask(retried)
      await load()
    } catch (error) { message.error(errorMessage(error)) } finally { setActioning('') }
  }
  const operationPanel = operationTask && <div className={`instance-operation is-${activeTask ? 'active' : 'failed'}`}>
    <div className="instance-operation-copy">
      <Space wrap><StatusTag value={operationTask.status} /><Typography.Text strong>{translateCode(t, operationTask.kind, 'taskKind')}</Typography.Text><Typography.Text type="secondary">· {translateCode(t, operationTask.stage)}</Typography.Text></Space>
      <Typography.Paragraph type={activeTask ? 'secondary' : 'danger'}>{activeTask ? translateCode(t, operationTask.message, 'taskMessage') : operationTask.errorCode && operationTask.errorCode !== 'task_failed' ? translateCode(t, operationTask.errorCode, 'taskError') : operationTask.errorMessage || translateCode(t, operationTask.message, 'taskMessage')}</Typography.Paragraph>
    </div>
    {activeTask && <Progress className="instance-operation-progress" percent={operationTask.progress} status="active" size="small" />}
    <Space className="instance-operation-actions">
      {failedTask && !activeTask && <Button type="primary" icon={<ReloadOutlined />} loading={actioning === 'retry-task'} disabled={!!actioning && actioning !== 'retry-task'} onClick={() => void retryTask()}>{t('retryTask')}</Button>}
      <Button onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewTask')}</Button>
    </Space>
  </div>
  const healthDescription = item.statusMessage ? translateCode(t, item.statusMessage, 'statusMessage') : item.status === 'running' ? t('noHealthIssue') : item.status === 'stopped' ? t('healthStopped') : item.status === 'provisioning' ? t('healthProvisioning') : item.status === 'degraded' ? t('healthDegraded') : t('healthUnavailable')
  const healthIcon = item.status === 'running' ? <CheckCircleOutlined /> : item.status === 'degraded' || item.status === 'provisioning' ? <WarningOutlined /> : item.status === 'failed' ? <CloseCircleOutlined /> : <PauseCircleOutlined />
  const healthTone = item.status === 'running' ? 'success' : item.status === 'degraded' || item.status === 'provisioning' ? 'warning' : item.status === 'failed' ? 'error' : 'neutral'
  const overview = <Row gutter={[16, 16]}><Col xs={24} xl={16}><Card title={t('runtime')}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'status', label: t('status'), children: <StatusTag value={item.status} /> },{ key: 'desired', label: t('desiredState'), children: translateCode(t, item.desiredState) },{ key: 'template', label: t('template'), children: `${item.templateName} ${item.templateVersion}` },{ key: 'host', label: t('host'), children: <Button type="link" className="description-link" onClick={() => navigate(`/hosts?host=${item.hostId}`)}>{item.hostName}</Button> },{ key: 'resource', label: t('resources'), children: `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },{ key: 'port', label: t('port'), children: `${item.bindAddress}:${item.hostPort} → ${item.containerPort}` },{ key: 'env', label: t('environment'), children: <Tag>{translateCode(t, item.environment)}</Tag> },{ key: 'restart', label: t('autoRestart'), children: item.autoRestart ? t('enabled') : t('disabled') },{ key: 'project', label: t('project'), children: project?.name || t('noProject') },{ key: 'created', label: t('createdAt'), children: new Date(item.createdAt).toLocaleString(i18n.language) },{ key: 'labels', label: t('labels'), span: 2, children: Object.keys(item.labels || {}).length ? <Space wrap>{Object.entries(item.labels).map(([key, value]) => <Tag key={key}>{key}={value}</Tag>)}</Space> : '—' }]} /></Card></Col><Col xs={24} xl={8}><Card title={t('health')} className="health-summary-card"><div className={`health-summary-icon is-${healthTone}`}>{healthIcon}</div><div className="health-summary-copy"><Space><StatusTag value={item.status} /><Typography.Text strong>{t('currentRuntimeState')}</Typography.Text></Space><Typography.Paragraph type="secondary">{healthDescription}</Typography.Paragraph></div><div className="health-facts"><div><Typography.Text type="secondary">{t('lastHealthy')}</Typography.Text><Typography.Text>{item.lastHealthyAt ? new Date(item.lastHealthyAt).toLocaleString(i18n.language) : t('notReported')}</Typography.Text></div><div><Typography.Text type="secondary">{t('restartFailures')}</Typography.Text><Typography.Text>{item.restartFailures}</Typography.Text></div></div></Card></Col></Row>
  const connectionTab = <Card title={t('connectionCredentials')} className="connection-card">{item.status !== 'running' && <Alert className="connection-status-alert" type="warning" showIcon message={t('connectionAvailabilityAffected')} description={t('connectionAvailabilityAffectedHint', { status: translateCode(t, item.status) })} />}{!connection ? <div className="connection-gate"><div className="connection-gate-icon"><LockOutlined /></div><Typography.Title level={4}>{t('connectionProtectedTitle')}</Typography.Title><Typography.Paragraph type="secondary">{t('connectionProtectedDescription')}</Typography.Paragraph><Button type="primary" loading={connectionLoading} onClick={() => void loadConnection()}>{t('showConnectionDetails')}</Button></div> : <><div className="connection-toolbar"><div><Typography.Text strong>{t('connectionReady')}</Typography.Text><Typography.Paragraph type="secondary">{t('connectionAuditNotice')}</Typography.Paragraph></div><Space wrap><Button icon={<CopyOutlined />} onClick={() => void copyText(environmentFile(connection)).then(() => message.success(t('environmentCopied'))).catch((error) => message.error(errorMessage(error)))}>{t('copyEnvironment')}</Button><Button icon={<EyeInvisibleOutlined />} onClick={() => setConnection(null)}>{t('hideConnectionDetails')}</Button><Button icon={<ReloadOutlined />} loading={connectionLoading} onClick={() => void loadConnection()}>{t('refresh')}</Button></Space></div><Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[{ key: 'address', label: t('address'), children: <Typography.Text copyable={{ text: connection.address, icon: <CopyOutlined /> }}>{connection.address}</Typography.Text> },{ key: 'port', label: t('port'), children: <Typography.Text copyable={{ text: String(connection.port), icon: <CopyOutlined /> }}>{connection.port}</Typography.Text> },{ key: 'username', label: t('username'), children: <Typography.Text copyable={{ text: connection.username, icon: <CopyOutlined /> }}>{connection.username}</Typography.Text> },{ key: 'password', label: t('password'), children: <Typography.Text code copyable={{ text: connection.password, icon: <CopyOutlined /> }}>{connection.password}</Typography.Text> },{ key: 'database', label: t('database'), children: <Typography.Text copyable={{ text: connection.database, icon: <CopyOutlined /> }}>{connection.database}</Typography.Text> }]} /><div className="connection-strings"><div className="connection-string"><Typography.Text type="secondary">{t('uri')}</Typography.Text><Typography.Text code copyable={{ text: connection.uri, icon: <CopyOutlined /> }}>{connection.uri}</Typography.Text></div>{connection.jdbc && <div className="connection-string"><Typography.Text type="secondary">{t('jdbc')}</Typography.Text><Typography.Text code copyable={{ text: connection.jdbc, icon: <CopyOutlined /> }}>{connection.jdbc}</Typography.Text></div>}</div></>}</Card>
  const logsTab = <Card className="ops-panel" loading={logsLoading && !logs && !logsError} extra={<Space wrap><Select aria-label={t('logLines')} value={logTail} onChange={setLogTail} options={[100, 500, 1000, 5000].map((value) => ({ value, label: t('logLineCount', { count: value }) }))} /><Space size={6}><Switch size="small" checked={logsAutoRefresh} onChange={setLogsAutoRefresh} /><Typography.Text type="secondary">{t('autoRefresh')}</Typography.Text></Space><Button icon={<ReloadOutlined />} loading={logsLoading} onClick={() => void loadLogs()}>{t('refresh')}</Button><Button href={`/api/v1/instances/${id}/logs?tail=${logTail}&download=true`}>{t('download')}</Button></Space>} title={<Space>{t('logs')}{logsUpdatedAt && <Typography.Text type="secondary" className="logs-updated">{t('lastRefreshedAt', { time: logsUpdatedAt.toLocaleTimeString(i18n.language) })}</Typography.Text>}</Space>}>{logsError && <Alert className="ops-alert" type="error" showIcon message={t('logsLoadFailed')} description={logsError} action={<Button size="small" onClick={() => void loadLogs()}>{t('retry')}</Button>} />}{logs ? <pre className="log-viewer">{logs}</pre> : !logsError && <EmptyState compact description={t('logsEmptyDescription')} />}</Card>
  const metricData = metrics.map((metric) => ({ ...metric, time: new Intl.DateTimeFormat(i18n.language, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(metric.collectedAt)) }))
  const latestMetric = metrics.at(-1)
  const metricsTab = <Card className="ops-panel" loading={metricsLoading && !metrics.length && !metricsError} title={t('metrics')} extra={<Space><Select aria-label={t('metricWindow')} value={metricHours} onChange={setMetricHours} options={[{ value: 1, label: t('lastHour') },{ value: 6, label: t('last6Hours') },{ value: 24, label: t('last24Hours') },{ value: 168, label: t('last7Days') }]} /><Button icon={<ReloadOutlined />} loading={metricsLoading} onClick={() => void loadMetrics()}>{t('refresh')}</Button></Space>}>{metricsError && <Alert className="ops-alert" type="error" showIcon message={t('metricsLoadFailed')} description={metricsError} action={<Button size="small" onClick={() => void loadMetrics()}>{t('retry')}</Button>} />}{latestMetric && <div className="metric-summary"><div className="metric-stat"><Typography.Text type="secondary">{t('cpu')}</Typography.Text><strong>{latestMetric.cpuPercent.toFixed(1)}%</strong></div><div className="metric-stat"><Typography.Text type="secondary">{t('memoryUsage')}</Typography.Text><strong>{latestMetric.memoryPercent.toFixed(1)}%</strong><span>{bytes(latestMetric.memoryBytes)}</span></div><div className="metric-stat"><Typography.Text type="secondary">{t('diskUsage')}</Typography.Text><strong>{latestMetric.diskTotalBytes > 0 ? `${(latestMetric.diskUsedBytes * 100 / latestMetric.diskTotalBytes).toFixed(1)}%` : t('notReported')}</strong>{latestMetric.diskTotalBytes > 0 && <span>{bytes(latestMetric.diskUsedBytes)} / {bytes(latestMetric.diskTotalBytes)}</span>}</div><div className="metric-stat"><Typography.Text type="secondary">{t('lastCollected')}</Typography.Text><strong className="metric-time">{new Date(latestMetric.collectedAt).toLocaleString(i18n.language)}</strong></div></div>}{metrics.length ? <div className="metric-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={metricData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}><CartesianGrid stroke="#e8edf4" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="time" minTickGap={48} tick={{ fill: '#667085', fontSize: 12 }} axisLine={{ stroke: '#dfe5ec' }} tickLine={false} /><YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: '#667085', fontSize: 12 }} axisLine={false} tickLine={false} /><ChartTooltip /><Legend /><Line type="monotone" dataKey="cpuPercent" name={t('cpuPercent')} stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line type="monotone" dataKey="memoryPercent" name={t('memoryPercent')} stroke="#0f9f8f" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /></LineChart></ResponsiveContainer></div> : !metricsError && <EmptyState compact description={t('metricsEmptyDescription')} />}</Card>
  const canStart = item.status === 'stopped' || (item.status === 'failed' && !failedTask && !activeTask)
  const canStopOrRestart = !operationTask && (item.status === 'running' || item.status === 'degraded')
  const canUpgrade = !operationTask && ['running', 'stopped', 'degraded'].includes(item.status)
  const moreActions = [{ key: 'upgrade', icon: <RocketOutlined />, label: t('upgrade'), disabled: !canUpgrade || !!actioning },{ type: 'divider' as const },{ key: 'delete', icon: <DeleteOutlined />, label: t('delete'), danger: true, disabled: item.status === 'provisioning' || !!actioning }]
  return <><PageHeader title={<Space><Button type="text" aria-label={t('instances')} title={t('instances')} icon={<LeftOutlined />} onClick={() => navigate('/instances')} /><DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" />{item.name}<StatusTag value={item.status} /></Space>} description={`${item.templateName} ${item.templateVersion} · ${item.hostName}`} actions={<><Button icon={<EditOutlined />} disabled={!!actioning} onClick={showEdit}>{t('edit')}</Button>{canStart && <Button type="primary" icon={<PlayCircleOutlined />} loading={actioning === 'start'} disabled={!!actioning && actioning !== 'start'} onClick={() => void run('start')}>{t('start')}</Button>}{canStopOrRestart && <Button icon={<PauseCircleOutlined />} loading={actioning === 'stop'} disabled={!!actioning && actioning !== 'stop'} onClick={() => void run('stop')}>{t('stop')}</Button>}{canStopOrRestart && <Button icon={<ReloadOutlined />} loading={actioning === 'restart'} disabled={!!actioning && actioning !== 'restart'} onClick={() => void run('restart')}>{t('restart')}</Button>}<Dropdown menu={{ items: moreActions, onClick: ({ key }) => key === 'upgrade' ? showUpgrade() : showDelete() }} trigger={['click']}><Button icon={<MoreOutlined />} disabled={!!actioning}>{t('moreActions')}</Button></Dropdown></>} />{pageError && <Alert className="instance-page-alert" type="warning" showIcon message={t('instanceRefreshFailed')} description={pageError} action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} />}{operationPanel}<Tabs activeKey={activeTab} onChange={changeTab} items={[{ key: 'overview', label: t('details'), children: overview },{ key: 'connection', label: t('connection'), children: connectionTab },{ key: 'logs', label: t('logs'), children: logsTab },{ key: 'metrics', label: t('metrics'), children: metricsTab }]} />
    <Modal title={t('edit')} open={editOpen} onCancel={() => { if (!editSaving) setEditOpen(false) }} onOk={() => void saveEdit()} confirmLoading={editSaving} okText={t('save')}><Form form={editForm} layout="vertical"><Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="projectId" label={t('project')}><Select allowClear options={projects.map((project) => ({ value: project.id, label: project.name }))} /></Form.Item><Form.Item name="environment" label={t('environment')} rules={[{ required: true }]}><Select options={['development', 'testing', 'staging', 'production'].map((value) => ({ value, label: translateCode(t, value) }))} /></Form.Item><Form.Item name="labels" label={t('labels')}><Input placeholder={t('labelsPlaceholder')} /></Form.Item><Form.Item name="autoRestart" label={t('autoRestart')} valuePropName="checked"><Switch /></Form.Item></Form></Modal>
    <Modal title={`${t('delete')} ${item.name}`} open={deleteOpen} onCancel={() => { if (!actioning) { setDeleteOpen(false); setConfirm('') } }} onOk={() => void run('delete', { confirmName: confirm })} confirmLoading={actioning === 'delete'} okButtonProps={{ danger: true, disabled: confirm !== item.name }}><Alert className="delete-instance-alert" type="error" showIcon message={t('deleteInstanceWarningTitle')} description={t('deleteInstanceWarningDescription')} /><Typography.Paragraph>{t('deleteInstanceConfirmHint', { name: item.name })}</Typography.Paragraph><Input autoFocus aria-label={t('deleteInstanceConfirmLabel', { name: item.name })} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={item.name} /></Modal>
    <Modal title={t('upgrade')} open={upgradeOpen} onCancel={() => { if (!actioning) setUpgradeOpen(false) }} onOk={() => upgradeVersion && void run('upgrade', { templateVersionId: upgradeVersion })} confirmLoading={actioning === 'upgrade'} okButtonProps={{ disabled: !upgradeVersion }}><Typography.Paragraph type="secondary">{t('upgradeHint')}</Typography.Paragraph><Select style={{ width: '100%' }} options={upgradeOptions} value={upgradeVersion} onChange={setUpgradeVersion} placeholder={t('version')} />{upgradeOptions.length === 0 && <Typography.Text type="warning">{t('noCompatibleVersion')}</Typography.Text>}</Modal>
  </>
}
