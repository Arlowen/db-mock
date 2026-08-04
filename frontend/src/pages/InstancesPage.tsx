import { CheckCircleOutlined, CloudServerOutlined, ControlOutlined, CopyOutlined, ExportOutlined, LeftOutlined, MoreOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, Descriptions, Drawer, Dropdown, Form, Grid, Input, InputNumber, Modal, Progress, Radio, Row, Select, Space, Steps, Switch, Table, Tag, Typography } from 'antd'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import { TaskFailureGuidance } from '../components/TaskFailureGuidance'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import appI18n from '../i18n'
import { ApiError, api, errorMessage } from '../lib/api'
import { connectionHandoffSummary } from '../lib/connection-handoff'
import { deploymentReturnPathForHost } from '../lib/deployment-continuation'
import { frequentTemplateVersions } from '../lib/frequent-template-versions'
import { hostCanAccept, hostDeploymentReadiness, hostHeadroomScore, remainingAfterDeployment, reservationForHost } from '../lib/host-capacity'
import { canRetryInstanceCreateRequest, instanceCreateRecoveryKey, type InstanceCreateRequestFailure } from '../lib/instance-create-recovery'
import { instanceHandoffAvailability, instanceHandoffRestoreVerification } from '../lib/instance-handoff'
import { instanceBatchActionPlan, instanceBatchTaskGroups, instanceListActions, type InstanceBatchAccepted, type InstanceBatchAction, type InstanceBatchActionResponse, type InstanceBatchActionResult, type InstanceBatchRejected } from '../lib/instance-actions'
import { formatDateTime, translateCode } from '../lib/localization'
import { mvpDatabaseTemplates, mvpInstanceCreatePayload, mvpTemplateImageReferences } from '../lib/mvp-instance-create'
import { permissionsFor } from '../lib/permissions'
import { restoreVerification } from '../lib/restore-verification'
import { taskFailureGuidance } from '../lib/task-failure'
import { taskHostRecoveryPathForTask } from '../lib/task-recovery'
import { useTaskNotification } from '../lib/task-notification'
import { templateAuthentication } from '../lib/template-authentication'
import { displayTemplateParameterValue, localizedTemplateText, templateParameterDefaults, templateParameters, templateResourceProfiles } from '../lib/template-options'
import type { DatabaseTemplate, Host, Instance, InstanceBackup, Task, TemplateParameter, TemplateParameterValue } from '../lib/types'
import { bytes } from '../lib/types'

interface CreateValues { name: string; templateVersionId: string; hostId?: string; cpu: number; memoryGiB: number; diskGiB: number; templateParameters?: Record<string, TemplateParameterValue> }

function batchActionErrorMessage(item: InstanceBatchRejected): string {
  const status = item.code === 'not_found' ? 404
    : item.code === 'resource_conflict' ? 409
      : item.code === 'forbidden' ? 403
        : item.code === 'unauthorized' ? 401
          : item.code === 'resource_unavailable' ? 503
            : item.code === 'invalid_input' ? 400
              : 500
  return errorMessage(new ApiError(status, item.code, item.message))
}

function connectionHandoffText(
  item: Instance,
  connection: Connection,
  verification: ReturnType<typeof restoreVerification>,
  t: TFunction,
  language: string,
  timezone: string,
) {
  return connectionHandoffSummary({
    instanceName: item.name,
    templateName: item.templateName,
    templateVersion: item.templateVersion,
    status: translateCode(t, item.status),
    dataVersion: verification?.backupName || verification?.backupId.slice(0, 8),
    backupCreatedAt: verification?.backupCreatedAt ? formatDateTime(verification.backupCreatedAt, language, timezone) : undefined,
    restoreVerifiedAt: verification?.healthVerifiedAt ? formatDateTime(verification.healthVerifiedAt, language, timezone) : undefined,
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

export function InstancesPage() {
  const { t, i18n } = useTranslation(); const { message, modal } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const [items, setItems] = useState<Instance[]>([]); const [templates, setTemplates] = useState<DatabaseTemplate[]>([]); const [hosts, setHosts] = useState<Host[]>([]); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [supportingDataError, setSupportingDataError] = useState(''); const [creationDataReady, setCreationDataReady] = useState(false); const [creating, setCreating] = useState(false); const [refreshingCreateContext, setRefreshingCreateContext] = useState(false); const [createDraftDirty, setCreateDraftDirty] = useState(false); const [createFailure, setCreateFailure] = useState<InstanceCreateRequestFailure>(); const initializedTemplateVersionID = useRef(''); const suppressRequestedCreateRef = useRef(false); const [drawer, setDrawer] = useState(false); const [step, setStep] = useState(0); const [search, setSearch] = useState(''); const [hostFilter, setHostFilter] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [form] = Form.useForm<CreateValues>()
  const [selectedInstanceIDs, setSelectedInstanceIDs] = useState<string[]>([])
  const [bulkAction, setBulkAction] = useState<InstanceBatchAction>()
  const [rowActionInstance, setRowActionInstance] = useState<Instance>()
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [bulkRequestError, setBulkRequestError] = useState('')
  const [bulkResult, setBulkResult] = useState<InstanceBatchActionResult>()
  const [bulkTracking, setBulkTracking] = useState(false)
  const [bulkTrackingError, setBulkTrackingError] = useState('')
  const [bulkRetryingTaskID, setBulkRetryingTaskID] = useState('')
  const [handoffItem, setHandoffItem] = useState<Instance>()
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffError, setHandoffError] = useState('')
  const [handoffResult, setHandoffResult] = useState<{ address: string; port: number; authentication: Connection['authentication']; verification?: ReturnType<typeof restoreVerification> }>()
  const handoffRequestID = useRef(0)
  const { user } = useAuth(); const { canOperate, canReadCredentials } = permissionsFor(user!)
  const { timezone } = useSystemSettings()
  const screens = Grid.useBreakpoint()
  const compactLayout = screens.md === false
  const load = useCallback(async () => {
    const [instanceResponse, templateResponse, hostResponse] = await Promise.allSettled([
      api<{ items: Instance[] }>('/instances'),
      api<{ items: DatabaseTemplate[] }>('/templates'),
      api<{ items: Host[] }>('/hosts'),
    ])
    if (instanceResponse.status === 'fulfilled') setItems(instanceResponse.value.items)
    if (templateResponse.status === 'fulfilled') setTemplates(templateResponse.value.items)
    if (hostResponse.status === 'fulfilled') setHosts(hostResponse.value.items)
    setLoadError(instanceResponse.status === 'rejected' ? errorMessage(instanceResponse.reason) : '')
    const supportingFailure = [templateResponse, hostResponse].find((result) => result.status === 'rejected')
    setSupportingDataError(supportingFailure?.status === 'rejected' ? errorMessage(supportingFailure.reason) : '')
    setCreationDataReady(templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled')
    setLoading(false)
  }, [])
  const mvpTemplates = useMemo(() => mvpDatabaseTemplates(templates), [templates])
  const hasOnlineHost = hosts.some((host) => host.status === 'online' && !host.maintenance)
  const createRequested = params.get('create') === '1'
  const requestedTemplateID = params.get('template')
  const requestedHostID = params.get('host')
  const requestedTemplateAvailable = !!requestedTemplateID && mvpTemplates.some((template) => template.versions.some((version) => version.id === requestedTemplateID && version.selectable !== false))
  const requestedVersion = mvpTemplates.flatMap((template) => template.versions).find((version) => version.id === requestedTemplateID && version.selectable !== false)
  const requestedCompatibleHosts = hosts.filter((host) => host.status === 'online' && !host.maintenance && (!requestedVersion || requestedVersion.architectures.includes(host.architecture || '')))
  const requestedHost = requestedHostID ? hosts.find((host) => host.id === requestedHostID) : undefined
  const requestedHostReady = !!requestedHost && requestedCompatibleHosts.some((host) => host.id === requestedHost.id)
  const createIntent = useCallback(() => {
    const path = `/instances?create=1${requestedTemplateID ? `&template=${encodeURIComponent(requestedTemplateID)}` : ''}`
    return deploymentReturnPathForHost(path, requestedHostID)
  }, [requestedHostID, requestedTemplateID])
  const addRequiredHost = useCallback(() => navigate(`/hosts?create=1&returnTo=${encodeURIComponent(createIntent())}`), [createIntent, navigate])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const available = new Set(items.map((item) => item.id))
    setSelectedInstanceIDs((current) => current.filter((id) => available.has(id)))
  }, [items])
  useEffect(() => {
    if (!createRequested) { suppressRequestedCreateRef.current = false; return }
    if (suppressRequestedCreateRef.current || drawer || loading || loadError || !creationDataReady) return
    if (!canOperate) { setParams({}, { replace: true }); return }
    if (requestedVersion ? requestedCompatibleHosts.length === 0 : !hasOnlineHost) { addRequiredHost(); return }
    initializedTemplateVersionID.current = ''
    setStep(0)
    setCreateFailure(undefined)
    setCreateDraftDirty(false)
    form.resetFields()
    form.setFieldsValue({
      templateVersionId: requestedTemplateAvailable ? requestedTemplateID || undefined : undefined,
      hostId: requestedHostReady ? requestedHostID || undefined : undefined,
    })
    setDrawer(true)
  }, [addRequiredHost, canOperate, createRequested, creationDataReady, drawer, form, hasOnlineHost, loadError, loading, requestedCompatibleHosts.length, requestedHostID, requestedHostReady, requestedTemplateAvailable, requestedTemplateID, requestedVersion, setParams])
  const selectedVersionID = Form.useWatch('templateVersionId', { form, preserve: true })
  const requestedName = Form.useWatch('name', { form, preserve: true })
  const selectedHostID = Form.useWatch('hostId', { form, preserve: true })
  const requestedCPU = Form.useWatch('cpu', { form, preserve: true })
  const requestedMemoryGiB = Form.useWatch('memoryGiB', { form, preserve: true })
  const requestedDiskGiB = Form.useWatch('diskGiB', { form, preserve: true })
  const submittedTemplateParameters = Form.useWatch('templateParameters', { form, preserve: true })
  const selected = useMemo(() => { for (const item of mvpTemplates) for (const version of item.versions) if (version.id === selectedVersionID && version.selectable !== false) return { template: item, version }; return undefined }, [mvpTemplates, selectedVersionID])
  const selectedAuthentication = selected ? templateAuthentication(selected.template, selected.version) : 'password'
  const frequentVersions = useMemo(() => frequentTemplateVersions(mvpTemplates), [mvpTemplates])
  const selectedTemplateParameters = useMemo(() => templateParameters(selected?.version), [selected])
  const selectedResourceProfiles = useMemo(() => templateResourceProfiles(selected?.version), [selected])
  const templateCompatibleHosts = useMemo(() => hosts.filter((host) => host.status === 'online' && !host.maintenance && (!selected || selected.version.architectures.includes(host.architecture || ''))), [hosts, selected])
  const selectedHost = templateCompatibleHosts.find((host) => host.id === selectedHostID)
  const compatibleHosts = templateCompatibleHosts
  const resourceRequest = useMemo(() => ({ cpu: requestedCPU || 0, memory: Math.round((requestedMemoryGiB || 0) * 1024 ** 3), disk: Math.round((requestedDiskGiB || 0) * 1024 ** 3), port: undefined }), [requestedCPU, requestedDiskGiB, requestedMemoryGiB])
  const resourceRequestReady = resourceRequest.cpu > 0 && resourceRequest.memory > 0 && resourceRequest.disk > 0
  const resourceHostScope = useMemo(() => selectedHost ? [selectedHost] : compatibleHosts, [compatibleHosts, selectedHost])
  const capacityCandidates = useMemo(() => resourceRequestReady ? resourceHostScope.filter((host) => hostCanAccept(host, reservationForHost(items, host.id), resourceRequest)) : resourceHostScope, [items, resourceHostScope, resourceRequest, resourceRequestReady])
  const capacityPreviewHost = useMemo(() => [...capacityCandidates].sort((a, b) => hostHeadroomScore(b, reservationForHost(items, b.id)) - hostHeadroomScore(a, reservationForHost(items, a.id)))[0], [capacityCandidates, items])
  const capacityRemaining = capacityPreviewHost && resourceRequestReady ? remainingAfterDeployment(capacityPreviewHost, reservationForHost(items, capacityPreviewHost.id), resourceRequest) : undefined
  const deploymentHostOptions = compatibleHosts.map((host) => {
    const readiness = resourceRequestReady ? hostDeploymentReadiness(host, reservationForHost(items, host.id), resourceRequest) : undefined
    const issues = readiness?.issues.map((issue) => t(`hostDeploymentIssue_${issue}`)).join(' / ')
    const detail = !readiness
      ? t('hostOptionAwaitingResources')
      : readiness.fits
        ? t('hostOptionRemaining', { cpu: readiness.remaining.cpu.toFixed(readiness.remaining.cpu % 1 ? 1 : 0), memory: bytes(readiness.remaining.memory), disk: bytes(readiness.remaining.disk) })
        : t('hostOptionUnavailable', { issues, cpu: readiness.available.cpu.toFixed(readiness.available.cpu % 1 ? 1 : 0), memory: bytes(readiness.available.memory), disk: bytes(readiness.available.disk) })
    return { value: host.id, label: `${host.name} · ${detail}`, searchText: `${host.name} ${host.architecture}`, disabled: !!readiness && !readiness.fits, host, readiness, detail }
  })
  const refreshCreateContext = async (failure = createFailure) => {
    if (!failure) return
    const values = form.getFieldsValue(true) as CreateValues
    setRefreshingCreateContext(true)
    setCreateFailure({ ...failure, contextStatus: 'checking', existingInstanceId: undefined, existingInstanceName: undefined })
    try {
      const [instanceResponse, templateResponse, hostResponse] = await Promise.allSettled([
        api<{ items: Instance[] }>('/instances'),
        api<{ items: DatabaseTemplate[] }>('/templates'),
        api<{ items: Host[] }>('/hosts'),
      ])
      if (instanceResponse.status === 'fulfilled') setItems(instanceResponse.value.items)
      if (templateResponse.status === 'fulfilled') setTemplates(templateResponse.value.items)
      if (hostResponse.status === 'fulfilled') setHosts(hostResponse.value.items)
      const coreReady = instanceResponse.status === 'fulfilled' && templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled'
      const normalizedName = values.name?.trim().toLocaleLowerCase()
      const existing = instanceResponse.status === 'fulfilled' && normalizedName
        ? instanceResponse.value.items.find((item) => item.name.trim().toLocaleLowerCase() === normalizedName)
        : undefined
      setCreationDataReady(templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled')
      setCreateFailure((current) => current ? {
        ...current,
        contextStatus: coreReady ? 'ready' : 'failed',
        existingInstanceId: existing?.id,
        existingInstanceName: existing?.name,
      } : current)
    } finally {
      setRefreshingCreateContext(false)
    }
  }
  const selectedHostReady = !selectedHostID || !!selectedHost
  const createDraftReady = creationDataReady &&
    !!selected &&
    !!requestedName?.trim() &&
    selectedHostReady &&
    resourceRequestReady &&
    capacityCandidates.length > 0
  const createRetryAllowed = !!createFailure && canRetryInstanceCreateRequest({
    ...createFailure,
    draftReady: createDraftReady,
  })
  const createRecoveryStep = !selected || !requestedName?.trim() || createFailure?.code === 'invalid_input'
    ? 0
    : !resourceRequestReady || capacityCandidates.length === 0 || !selectedHostReady
      ? 1
      : 2
  useEffect(() => {
    if (!selected) return
    if (initializedTemplateVersionID.current === selected.version.id) return
    initializedTemplateVersionID.current = selected.version.id
    const manifest = selected.version.manifest
    const profile = selectedResourceProfiles[0]
    form.setFieldsValue({
      cpu: profile?.cpu ?? selected.version.minCpu,
      memoryGiB: (profile?.memoryBytes ?? selected.version.minMemoryBytes) / 1024 ** 3,
      diskGiB: (profile?.diskBytes ?? selected.version.minDiskBytes) / 1024 ** 3,
      templateParameters: templateParameterDefaults(selectedTemplateParameters),
    })
  }, [form, selected, selectedResourceProfiles, selectedTemplateParameters])
  useEffect(() => {
    if (!selected) return
    if (selectedHostID && !templateCompatibleHosts.some((host) => host.id === selectedHostID)) form.setFieldValue('hostId', undefined)
  }, [form, selected, selectedHostID, templateCompatibleHosts])
  const activeResourceProfile = selectedResourceProfiles.find((profile) => profile.cpu === requestedCPU && profile.memoryBytes === Math.round((requestedMemoryGiB || 0) * 1024 ** 3) && profile.diskBytes === Math.round((requestedDiskGiB || 0) * 1024 ** 3))
  const chooseTemplateVersion = (value: string) => {
    form.setFieldValue('templateVersionId', value)
    setCreateDraftDirty(true)
  }
  const openCreate = () => {
    if (!hasOnlineHost) { addRequiredHost(); return }
    initializedTemplateVersionID.current = ''
    setDrawer(true)
    setStep(0)
    setCreateFailure(undefined)
    setCreateDraftDirty(false)
    form.resetFields()
    form.setFieldsValue({})
  }
  const finishCloseCreate = () => { suppressRequestedCreateRef.current = true; setDrawer(false); setParams({}, { replace: true }); initializedTemplateVersionID.current = ''; setStep(0); setCreateFailure(undefined); setCreateDraftDirty(false); form.resetFields() }
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
    const fields: Array<keyof CreateValues> = step === 0 ? ['templateVersionId', 'name'] : step === 1 ? ['cpu', 'memoryGiB', 'diskGiB', 'templateParameters'] : []
    try {
      await form.validateFields(fields)
      if (step === 0 && compatibleHosts.length === 0) return
      if (step === 1 && capacityCandidates.length === 0) return
      setCreateFailure(undefined)
      setStep(Math.min(step + 1, 2))
    } catch { /* form marks errors */ }
  }
  const create = async () => {
    try {
      setCreating(true)
      setCreateFailure(undefined)
      await form.validateFields()
      const values = form.getFieldsValue(true) as CreateValues
      const payload = mvpInstanceCreatePayload(values)
      const result = await api<{ instance: Instance; task: Task }>('/instances', { method: 'POST', body: payload })
      notifyTask(result.task)
      finishCloseCreate()
      navigate(`/instances/${result.instance.id}`)
    } catch (e) {
      if (e instanceof Error) {
        const failure: InstanceCreateRequestFailure = {
          code: e instanceof ApiError ? e.code : 'network_error',
          message: errorMessage(e),
          serverRejected: e instanceof ApiError,
          contextStatus: 'checking',
        }
        setCreateFailure(failure)
        await refreshCreateContext(failure)
      }
    } finally { setCreating(false) }
  }
  const selectedInstances = useMemo(() => {
    const selected = new Set(selectedInstanceIDs)
    return items.filter((item) => selected.has(item.id))
  }, [items, selectedInstanceIDs])
  const startBatchPlan = useMemo(() => instanceBatchActionPlan(selectedInstances, 'start'), [selectedInstances])
  const stopBatchPlan = useMemo(() => instanceBatchActionPlan(selectedInstances, 'stop'), [selectedInstances])
  const restartBatchPlan = useMemo(() => instanceBatchActionPlan(selectedInstances, 'restart'), [selectedInstances])
  const rowActionPlan = useMemo(() => rowActionInstance && bulkAction ? instanceBatchActionPlan([rowActionInstance], bulkAction) : undefined, [bulkAction, rowActionInstance])
  const activeBatchPlan = rowActionPlan || (bulkAction === 'start' ? startBatchPlan : bulkAction === 'restart' ? restartBatchPlan : stopBatchPlan)
  const openBatchAction = (action: InstanceBatchAction) => {
    setBulkRequestError('')
    setRowActionInstance(undefined)
    setBulkAction(action)
  }
  const openRowAction = (item: Instance, action: InstanceBatchAction) => {
    setBulkRequestError('')
    setRowActionInstance(item)
    setBulkAction(action)
  }
  const submitBatchAction = async (action: InstanceBatchAction, instanceIDs: string[], skipped: Instance[], keepConfirmationOpen: boolean) => {
    const source = rowActionInstance ? 'row' : 'selection'
    try {
      setBulkSubmitting(true)
      setBulkRequestError('')
      setBulkTrackingError('')
      const result = await api<InstanceBatchActionResponse>(`/instances/batch-actions/${action}`, {
        method: 'POST',
        body: { instanceIds: instanceIDs },
      })
      result.accepted.forEach((item) => notifyTask(item.task))
      setBulkResult((current) => {
        if (keepConfirmationOpen || !current) return { ...result, skipped, source, contextName: rowActionInstance?.name }
        const retried = new Set(instanceIDs)
        return {
          action: result.action,
          accepted: [...current.accepted, ...result.accepted],
          rejected: [...current.rejected.filter((item) => !retried.has(item.instanceId)), ...result.rejected],
          skipped: current.skipped,
        }
      })
      setBulkAction(undefined)
      setRowActionInstance(undefined)
      if (source === 'selection') setSelectedInstanceIDs([])
      setLoading(true)
      await load()
    } catch (error) {
      if (keepConfirmationOpen) setBulkRequestError(errorMessage(error))
      else message.error(errorMessage(error))
    } finally {
      setBulkSubmitting(false)
    }
  }
  const bulkTaskGroups = useMemo(() => instanceBatchTaskGroups(bulkResult?.accepted || []), [bulkResult?.accepted])
  const trackedBatchTaskIDs = useMemo(() => (bulkResult?.accepted || []).map((item) => item.task.id).join(','), [bulkResult?.accepted])
  const refreshTrackedBatchTasks = useCallback(async (showLoading = true) => {
    if (!trackedBatchTaskIDs) return
    try {
      if (showLoading) setBulkTracking(true)
      const response = await api<{ items: Task[] }>(`/tasks?ids=${encodeURIComponent(trackedBatchTaskIDs)}`)
      const tasksByID = new Map(response.items.map((task) => [task.id, task]))
      setBulkResult((current) => current ? {
        ...current,
        accepted: current.accepted.map((item) => tasksByID.has(item.task.id) ? { ...item, task: tasksByID.get(item.task.id)! } : item),
      } : current)
      setBulkTrackingError('')
      if (response.items.length > 0 && response.items.every((task) => ['succeeded', 'failed', 'canceled', 'interrupted'].includes(task.status))) {
        await load()
      }
    } catch (error) {
      setBulkTrackingError(errorMessage(error))
    } finally {
      if (showLoading) setBulkTracking(false)
    }
  }, [load, trackedBatchTaskIDs])
  useEffect(() => {
    if (!trackedBatchTaskIDs || bulkTaskGroups.active.length === 0) return
    void refreshTrackedBatchTasks(false)
    const timer = window.setInterval(() => void refreshTrackedBatchTasks(false), 3000)
    return () => window.clearInterval(timer)
  }, [bulkTaskGroups.active.length, refreshTrackedBatchTasks, trackedBatchTaskIDs])
  const retryBatchTask = async (item: InstanceBatchAccepted) => {
    try {
      setBulkRetryingTaskID(item.task.id)
      setBulkTrackingError('')
      const task = await api<Task>(`/tasks/${item.task.id}/retry`, { method: 'POST', body: {} })
      notifyTask(task)
      setBulkResult((current) => current ? {
        ...current,
        accepted: current.accepted.map((accepted) => accepted.task.id === item.task.id ? { ...accepted, task } : accepted),
      } : current)
      await load()
    } catch (error) {
      setBulkTrackingError(errorMessage(error))
    } finally {
      setBulkRetryingTaskID('')
    }
  }
  const retryableRejected = bulkResult?.rejected.filter((item) => ['internal_error', 'resource_unavailable'].includes(item.code)) || []
  const clearSelection = () => {
    setSelectedInstanceIDs([])
    setBulkAction(undefined)
    setRowActionInstance(undefined)
    setBulkRequestError('')
    setBulkTrackingError('')
  }
  const openConnectionHandoff = (item: Instance) => {
    handoffRequestID.current += 1
    setHandoffItem(item)
    setHandoffLoading(false)
    setHandoffError('')
    setHandoffResult(undefined)
  }
  const closeConnectionHandoff = () => {
    handoffRequestID.current += 1
    setHandoffItem(undefined)
    setHandoffLoading(false)
    setHandoffError('')
    setHandoffResult(undefined)
  }
  const copyConnectionHandoff = async () => {
    if (!handoffItem) return
    const requestID = ++handoffRequestID.current
    try {
      setHandoffLoading(true)
      setHandoffError('')
      setHandoffResult(undefined)
      const [connection, taskResponse, backupResponse] = await Promise.all([
        api<Connection>(`/instances/${handoffItem.id}/connection`),
        api<{ items: Task[] }>(`/instances/${handoffItem.id}/tasks`),
        api<{ items: InstanceBackup[] }>(`/instances/${handoffItem.id}/backups`),
      ])
      if (requestID !== handoffRequestID.current) return
      const verification = instanceHandoffRestoreVerification(handoffItem, taskResponse.items, backupResponse.items)
      await copyText(connectionHandoffText(handoffItem, connection, verification, t, i18n.language, timezone))
      if (requestID !== handoffRequestID.current) return
      setHandoffResult({
        address: connection.address,
        port: connection.port,
        authentication: connection.authentication || 'password',
        verification,
      })
    } catch (error) {
      if (requestID === handoffRequestID.current) setHandoffError(errorMessage(error))
    } finally {
      if (requestID === handoffRequestID.current) setHandoffLoading(false)
    }
  }
  const instanceActions = (item: Instance) => {
    const lifecycleActions = canOperate ? instanceListActions(item.status) : []
    const handoffAvailability = instanceHandoffAvailability(item, canReadCredentials)
    return <Space size={2} className="instance-row-actions">
      {lifecycleActions.length > 0 && <Dropdown
        trigger={['click']}
        menu={{
          items: lifecycleActions.map((action) => ({
            key: action,
            label: t(action),
            icon: action === 'start' ? <PlayCircleOutlined /> : action === 'stop' ? <PauseCircleOutlined /> : <ReloadOutlined />,
            danger: action === 'stop',
          })),
          onClick: ({ key }) => openRowAction(item, key as InstanceBatchAction),
        }}
      >
        <Button
          type="text"
          disabled={bulkSubmitting}
          aria-label={t('instanceLifecycleActionsForInstance', { name: item.name })}
          title={t('instanceLifecycleActionsForInstance', { name: item.name })}
          icon={<ControlOutlined />}
        >
          <span className="instance-row-lifecycle-label">{t('instanceLifecycleActions')}</span>
        </Button>
      </Dropdown>}
      {canReadCredentials && <Button
        type="text"
        disabled={handoffAvailability !== 'ready'}
        aria-label={t('quickConnectionHandoff')}
        title={handoffAvailability === 'ready' ? t('quickConnectionHandoffForInstance', { name: item.name }) : t('quickConnectionHandoffUnavailable')}
        icon={<ExportOutlined />}
        onClick={() => openConnectionHandoff(item)}
      />}
      <Button type="text" aria-label={t('details')} title={t('details')} icon={<MoreOutlined />} onClick={() => navigate(`/instances/${item.id}`)} />
    </Space>
  }
  const desktopColumns = [
    { title: t('name'), dataIndex: 'name', width: 145, ellipsis: true, render: (value: string, item: Instance) => <Button type="link" className="instance-table-name" title={value} onClick={() => navigate(`/instances/${item.id}`)}>{value}</Button> },
    { title: t('template'), width: 165, ellipsis: true, render: (_: unknown, item: Instance) => <Space><DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" /><span>{item.templateName} <Typography.Text type="secondary">{item.templateVersion}</Typography.Text></span></Space> },
    { title: t('status'), dataIndex: 'status', width: 95, render: (value: string) => <StatusTag value={value} /> },
    { title: t('host'), width: 155, ellipsis: true, render: (_: unknown, item: Instance) => <><Typography.Text>{item.hostName}</Typography.Text><br /><Typography.Text type="secondary">{item.connectionAddress}:{item.hostPort}</Typography.Text></> },
    { title: t('resources'), width: 195, render: (_: unknown, item: Instance) => `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },
    { title: '', align: 'right' as const, fixed: 'right' as const, width: 185, render: (_: unknown, item: Instance) => instanceActions(item) },
  ]
  const mobileColumns = [
    {
      key: 'mobile',
      render: (_: unknown, item: Instance) => <div className="instance-mobile-summary">
        <div className="instance-mobile-summary-header">
          <Button type="link" className="instance-table-name" title={item.name} onClick={() => navigate(`/instances/${item.id}`)}>{item.name}</Button>
          {instanceActions(item)}
        </div>
        <div className="instance-mobile-template">
          <DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" />
          <div>
            <Typography.Text strong>{item.templateName} {item.templateVersion}</Typography.Text>
            <Typography.Text type="secondary">{item.hostName} · {item.connectionAddress}:{item.hostPort}</Typography.Text>
          </div>
        </div>
        <Space size={[6, 6]} wrap>
          <StatusTag value={item.status} />
          <Typography.Text type="secondary">{item.cpu} CPU · {bytes(item.memoryBytes)} · {bytes(item.reservedDiskBytes)}</Typography.Text>
        </Space>
      </div>,
    },
  ]
  const columns = compactLayout ? mobileColumns : desktopColumns
  const versionOptions = mvpTemplates.flatMap((item) => item.versions.filter((version) => version.selectable !== false).map((version) => ({ value: version.id, searchText: `${item.name} ${item.nameZh} ${version.version} ${mvpTemplateImageReferences(version).join(' ')}`, label: `${item.name} ${version.version}`, template: item, version })))
  const filteredItems = useMemo(() => items.filter((item) => (!hostFilter || item.hostId === hostFilter) && (!statusFilter || item.status === statusFilter) && `${item.name} ${item.templateName} ${item.hostName}`.toLowerCase().includes(search.toLowerCase())), [items, hostFilter, statusFilter, search])
  const hasFilters = !!(search || hostFilter || statusFilter)
  const showFilters = items.length > 0 || hasFilters
  useEffect(() => {
    setSelectedInstanceIDs([])
    setBulkAction(undefined)
    setBulkRequestError('')
  }, [hostFilter, search, statusFilter])
  const resetPage = () => setPage(1)
  const clearFilters = () => {
    setSearch('')
    setHostFilter('')
    setStatusFilter('')
    resetPage()
  }
  const emptyAction = hasFilters ? clearFilters : canOperate ? creationDataReady ? openCreate : () => { setLoading(true); void load() } : undefined
  const emptyActionLabel = hasFilters ? t('clearFilters') : canOperate ? creationDataReady ? hasOnlineHost ? t('createInstance') : t('addHost') : t('retry') : undefined
  const emptyDescription = hasFilters ? t('instancesFilteredEmptyDescription') : creationDataReady ? t('instancesEmptyDescription') : t('instanceCreationDataUnavailable')
  const listActions = <Space wrap><Button loading={loading} icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>{canOperate && creationDataReady && (items.length > 0 || hasFilters) && <Button type="primary" icon={hasOnlineHost ? <PlusOutlined /> : <CloudServerOutlined />} onClick={openCreate}>{hasOnlineHost ? t('createInstance') : t('addHost')}</Button>}</Space>
  const bulkToolbar = canOperate && selectedInstances.length > 0 && <Card size="small" className="instance-bulk-toolbar">
    <div className="instance-bulk-toolbar-copy">
      <Typography.Text strong>{t('batchSelectionCount', { count: selectedInstances.length })}</Typography.Text>
      <Typography.Text type="secondary">{t('batchSelectionSummary', { start: startBatchPlan.eligible.length, stop: stopBatchPlan.eligible.length, restart: restartBatchPlan.eligible.length })}</Typography.Text>
    </div>
    <Space wrap className="instance-bulk-toolbar-actions">
      <Button type="primary" icon={<PlayCircleOutlined />} disabled={startBatchPlan.eligible.length === 0 || bulkSubmitting} onClick={() => openBatchAction('start')}>{t('batchStartCount', { count: startBatchPlan.eligible.length })}</Button>
      <Button danger icon={<PauseCircleOutlined />} disabled={stopBatchPlan.eligible.length === 0 || bulkSubmitting} onClick={() => openBatchAction('stop')}>{t('batchStopCount', { count: stopBatchPlan.eligible.length })}</Button>
      <Button icon={<ReloadOutlined />} disabled={restartBatchPlan.eligible.length === 0 || bulkSubmitting} onClick={() => openBatchAction('restart')}>{t('batchRestartCount', { count: restartBatchPlan.eligible.length })}</Button>
      <Button disabled={bulkSubmitting} onClick={clearSelection}>{t('clearSelection')}</Button>
    </Space>
  </Card>
  const trackedBatchTasks = [...bulkTaskGroups.failed, ...bulkTaskGroups.active, ...bulkTaskGroups.succeeded]
  const singleResultName = bulkResult?.contextName || bulkResult?.accepted[0]?.instanceName || bulkResult?.rejected[0]?.instanceName || t('database')
  const bulkResultType = bulkTaskGroups.failed.length > 0 || (bulkResult?.rejected.length && !bulkResult.accepted.length)
    ? 'error'
    : bulkResult?.rejected.length || bulkTaskGroups.active.length > 0
      ? 'warning'
      : 'success'
  const bulkResultAlert = bulkResult && <Alert
    className="instance-bulk-result"
    type={bulkResultType}
    showIcon
    message={bulkResult.source === 'row'
      ? bulkTaskGroups.failed.length > 0
        ? t('instanceActionNeedsAttentionTitle', { action: t(bulkResult.action), name: singleResultName })
        : bulkTaskGroups.active.length > 0
          ? t('instanceActionInProgressTitle', { action: t(bulkResult.action), name: singleResultName })
          : bulkResult.accepted.length > 0
            ? t('instanceActionCompletedTitle', { action: t(bulkResult.action), name: singleResultName })
            : t('instanceActionNotQueuedTitle', { action: t(bulkResult.action), name: singleResultName })
      : bulkTaskGroups.failed.length > 0
        ? t('batchActionNeedsAttentionTitle', { count: bulkTaskGroups.failed.length })
      : bulkTaskGroups.active.length > 0
        ? t('batchActionInProgressTitle', { action: t(bulkResult.action), count: bulkTaskGroups.active.length })
        : bulkResult.accepted.length > 0
          ? t('batchActionCompletedTitle', { action: t(bulkResult.action), count: bulkTaskGroups.succeeded.length })
          : t('batchActionFailedTitle', { count: bulkResult.rejected.length })}
    description={<div className="instance-bulk-result-details">
      {bulkResult.accepted.length > 0 && <Typography.Text className="instance-bulk-progress-summary">{bulkResult.source === 'row' ? t('instanceActionProgressHint') : t('batchProgressSummary', { active: bulkTaskGroups.active.length, succeeded: bulkTaskGroups.succeeded.length, failed: bulkTaskGroups.failed.length })}</Typography.Text>}
      {bulkResult.skipped.length > 0 && <Typography.Text type="secondary">{t('batchSkippedSummary', { count: bulkResult.skipped.length })}</Typography.Text>}
      {bulkResult.rejected.length > 0 && <ul>{bulkResult.rejected.slice(0, 5).map((item) => <li key={item.instanceId}><strong>{item.instanceName || item.instanceId.slice(0, 8)}</strong>: {batchActionErrorMessage(item)}</li>)}</ul>}
      {bulkResult.rejected.length > 5 && <Typography.Text type="secondary">{t('batchMoreFailures', { count: bulkResult.rejected.length - 5 })}</Typography.Text>}
      {bulkTrackingError && <Alert type="warning" showIcon message={t('batchTrackingFailed')} description={bulkTrackingError} />}
      {trackedBatchTasks.length > 0 && <div className="instance-bulk-task-list">
        {trackedBatchTasks.slice(0, 6).map((item) => {
          const failed = ['failed', 'canceled', 'interrupted'].includes(item.task.status)
          const guidance = failed ? taskFailureGuidance(item.task) : undefined
          const hostRecoveryPath = guidance?.inspectHost ? taskHostRecoveryPathForTask(item.task) : undefined
          const hostName = hosts.find((host) => host.id === item.task.hostId)?.name
          return <div key={item.task.id} className={`instance-bulk-task-item${failed ? ' is-failed' : ''}`}>
            <div className="instance-bulk-task-header">
              <div>
                <Typography.Text strong>{item.instanceName || item.instanceId.slice(0, 8)}</Typography.Text>
                <Space size={6} wrap>
                  <StatusTag value={item.task.status} />
                  {item.task.stage !== item.task.status && <Typography.Text type="secondary">{translateCode(t, item.task.stage, 'taskStage')}</Typography.Text>}
                </Space>
              </div>
              <Space size={6} wrap className="instance-bulk-task-actions">
                {hostRecoveryPath && <Button size="small" type="primary" icon={<CloudServerOutlined />} onClick={() => navigate(hostRecoveryPath)}>{t('inspectFailedHost')}</Button>}
                {failed && !hostRecoveryPath && <Button size="small" type="primary" icon={<ReloadOutlined />} loading={bulkRetryingTaskID === item.task.id} disabled={!!bulkRetryingTaskID && bulkRetryingTaskID !== item.task.id} onClick={() => void retryBatchTask(item)}>{t('retryTask')}</Button>}
                <Button size="small" onClick={() => navigate(`/tasks?task=${item.task.id}`)}>{t('viewTask')}</Button>
              </Space>
            </div>
            {!failed && <Progress percent={item.task.progress} status={item.task.status === 'succeeded' ? 'success' : 'active'} size="small" />}
            {failed && <TaskFailureGuidance task={item.task} hostName={hostName} />}
          </div>
        })}
        {trackedBatchTasks.length > 6 && <Typography.Text type="secondary">{t('batchMoreTrackedTasks', { count: trackedBatchTasks.length - 6 })}</Typography.Text>}
      </div>}
    </div>}
    action={<Space wrap>
      {retryableRejected.length > 0 && <Button size="small" loading={bulkSubmitting} onClick={() => void submitBatchAction(bulkResult.action, retryableRejected.map((item) => item.instanceId), [], false)}>{t('retryUnqueuedCount', { count: retryableRejected.length })}</Button>}
      {bulkResult.accepted.length > 0 && <Button size="small" icon={<ReloadOutlined />} loading={bulkTracking} onClick={() => void refreshTrackedBatchTasks()}>{t('refreshBatchProgress')}</Button>}
      <Button size="small" onClick={() => navigate('/tasks')}>{t('viewBatchTasks')}</Button>
      <Button size="small" type="text" onClick={() => { setBulkResult(undefined); setBulkTrackingError('') }}>{t('dismiss')}</Button>
    </Space>}
  />
  const createSteps = [{ title: t('databaseAndName') }, { title: t('resourcesAndHost') }, { title: t('confirm') }]
  const parameterInput = (parameter: TemplateParameter) => {
    if (parameter.type === 'number') return <InputNumber min={parameter.min} max={parameter.max} step={parameter.step} style={{ width: '100%' }} />
    if (parameter.type === 'boolean') return <Switch />
    if (parameter.type === 'select') return <Select options={(parameter.options || []).map((option) => ({ value: option.value, label: localizedTemplateText(option.label, option.labelZh, i18n.language) }))} />
    return <Input maxLength={4096} />
  }
  const parameterRequiredRule = (parameter: TemplateParameter) => ({ validator: (_: unknown, value: TemplateParameterValue | undefined) => !parameter.required || value !== undefined && (typeof value !== 'string' || value.trim() !== '') ? Promise.resolve() : Promise.reject(new Error(t('templateParameterRequired', { label: localizedTemplateText(parameter.label, parameter.labelZh, i18n.language) }))) })
  return <><PageHeader title={t('databases')} description={t('instancesDescription')} />
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('instanceListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {supportingDataError && <Alert className="instance-page-alert" type="warning" showIcon message={t('instanceSupportingDataLoadFailed')} description={supportingDataError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {showFilters && <Card className="table-filter-card instance-filter-card"><div className="instance-filter-toolbar"><Input.Search allowClear value={search} aria-label={t('instancesSearchLabel')} placeholder={t('instancesSearchPlaceholder')} onChange={(event) => { setSearch(event.target.value); resetPage() }} className="instance-filter-search" /><Select aria-label={t('host')} value={hostFilter} onChange={(value) => { setHostFilter(value); resetPage() }} className="instance-filter-host" options={[{ value: '', label: t('allHosts') }, ...hosts.map((host) => ({ value: host.id, label: host.name }))]} /><Select aria-label={t('status')} value={statusFilter} onChange={(value) => { setStatusFilter(value); resetPage() }} className="instance-filter-status" options={[{ value: '', label: t('allStatuses') }, ...['provisioning', 'running', 'stopped', 'degraded', 'failed'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Typography.Text type="secondary" className="instance-filter-count" aria-live="polite">{hasFilters ? t('instanceFilteredResultCount', { filtered: filteredItems.length, total: items.length }) : t('instanceResultCount', { count: items.length })}</Typography.Text>{listActions}</div></Card>}
    {bulkResultAlert}
    {(items.length > 0 || !loadError) && <Card className="instance-table-card" extra={!showFilters ? listActions : undefined}><Table rowKey="id" loading={loading} dataSource={filteredItems} columns={columns} showHeader={!compactLayout} scroll={compactLayout ? undefined : { x: 860 }} pagination={{ current: page, pageSize, showSizeChanger: !compactLayout, pageSizeOptions: [20, 50], onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize) } }} locale={{ emptyText: <EmptyState compact action={emptyAction} actionLabel={emptyActionLabel} description={emptyDescription} /> }} /></Card>}
    <Modal
      className="instance-handoff-modal"
      title={handoffItem ? t('quickConnectionHandoffTitle', { name: handoffItem.name }) : t('quickConnectionHandoff')}
      open={!!handoffItem}
      onCancel={closeConnectionHandoff}
      width={620}
      destroyOnHidden
      footer={<div className="instance-handoff-footer">
        <Button onClick={closeConnectionHandoff}>{t(handoffResult ? 'close' : 'cancel')}</Button>
        <Space wrap>
          <Button onClick={() => {
            if (!handoffItem) return
            const id = handoffItem.id
            closeConnectionHandoff()
            navigate(`/instances/${id}?tab=connection`)
          }}>{t('openFullConnection')}</Button>
          <Button type="primary" icon={<CopyOutlined />} loading={handoffLoading} onClick={() => void copyConnectionHandoff()}>
            {t(handoffResult ? 'copyConnectionHandoffAgain' : handoffError ? 'retryCopyConnectionHandoff' : 'revealAndCopyConnectionHandoff')}
          </Button>
        </Space>
      </div>}
    >
      <div className="instance-handoff-body">
        <Typography.Paragraph type="secondary">{t('quickConnectionHandoffIntro')}</Typography.Paragraph>
        {handoffItem && <Descriptions
          className="connection-handoff-context"
          title={t('connectionHandoffContextTitle')}
          size="small"
          bordered
          column={1}
          items={[
            { key: 'database', label: t('database'), children: `${handoffItem.templateName} ${handoffItem.templateVersion}` },
            { key: 'status', label: t('status'), children: <StatusTag value={handoffItem.status} /> },
          ]}
        />}
        {!handoffError && !handoffResult && <Alert
          type="info"
          showIcon
          message={t('quickConnectionHandoffProtectedTitle')}
          description={t('quickConnectionHandoffAuditNotice')}
        />}
        {handoffError && <Alert
          type="error"
          showIcon
          message={t('quickConnectionHandoffFailedTitle')}
          description={<div className="instance-handoff-error"><Typography.Text>{handoffError}</Typography.Text><Typography.Text type="secondary">{t('quickConnectionHandoffFailedHint')}</Typography.Text></div>}
        />}
        {handoffResult && <Alert
          type="success"
          showIcon
          message={t('quickConnectionHandoffCopiedTitle')}
          description={t('quickConnectionHandoffCopiedHint')}
        />}
        {handoffResult && <Descriptions className="instance-handoff-facts" size="small" bordered column={1} items={[
          { key: 'endpoint', label: t('connectionEndpoint'), children: <Typography.Text code>{handoffResult.address}:{handoffResult.port}</Typography.Text> },
          { key: 'authentication', label: t('authentication'), children: t(`authenticationMode_${handoffResult.authentication}`) },
          { key: 'data-version', label: t('connectionHandoffDataVersion'), children: handoffResult.verification?.backupName || handoffResult.verification?.backupId.slice(0, 8) || t('connectionHandoffDefaultDataVersion') },
        ]} />}
        {handoffResult && <Typography.Text className="instance-handoff-sensitive-note" type="secondary">{t('quickConnectionHandoffSensitiveHint')}</Typography.Text>}
      </div>
    </Modal>
    <Modal
      title={bulkAction ? rowActionInstance
        ? t(bulkAction === 'stop' ? 'instanceStopConfirmTitle' : bulkAction === 'restart' ? 'instanceRestartConfirmTitle' : 'instanceStartConfirmTitle', { name: rowActionInstance.name })
        : t(bulkAction === 'stop' ? 'batchStopConfirmTitle' : bulkAction === 'restart' ? 'batchRestartConfirmTitle' : 'batchStartConfirmTitle', { count: activeBatchPlan.eligible.length }) : ''}
      open={!!bulkAction}
      onCancel={() => { if (!bulkSubmitting) { setBulkAction(undefined); setRowActionInstance(undefined); setBulkRequestError('') } }}
      onOk={() => bulkAction && void submitBatchAction(bulkAction, activeBatchPlan.eligible.map((item) => item.id), activeBatchPlan.skipped, true)}
      okText={bulkAction ? rowActionInstance
        ? t(bulkAction === 'stop' ? 'confirmInstanceStop' : bulkAction === 'restart' ? 'confirmInstanceRestart' : 'confirmInstanceStart')
        : t(bulkAction === 'stop' ? 'confirmBatchStop' : bulkAction === 'restart' ? 'confirmBatchRestart' : 'confirmBatchStart', { count: activeBatchPlan.eligible.length }) : t('confirm')}
      cancelText={t('cancel')}
      confirmLoading={bulkSubmitting}
      closable={!bulkSubmitting}
      maskClosable={!bulkSubmitting}
      okButtonProps={{ danger: bulkAction === 'stop', disabled: !bulkAction || activeBatchPlan.eligible.length === 0 }}
    >
      <div className="instance-bulk-confirm">
        <Alert
          type={bulkAction === 'stop' || bulkAction === 'restart' ? 'warning' : 'info'}
          showIcon
          message={rowActionInstance
            ? bulkAction === 'stop' ? t('instanceStopConfirmMessage') : bulkAction === 'restart' ? t('instanceRestartConfirmMessage') : t('instanceStartConfirmMessage')
            : bulkAction === 'stop' ? t('batchStopConfirmMessage') : bulkAction === 'restart' ? t('batchRestartConfirmMessage') : t('batchStartConfirmMessage')}
          description={rowActionInstance
            ? t(bulkAction === 'stop' ? 'instanceStopConfirmImpact' : bulkAction === 'restart' ? 'instanceRestartConfirmImpact' : 'instanceStartConfirmImpact')
            : t('batchConfirmImpact', { eligible: activeBatchPlan.eligible.length, skipped: activeBatchPlan.skipped.length })}
        />
        <div>
          <Typography.Text strong>{t(rowActionInstance ? 'instanceActionTarget' : 'batchWillQueue')}</Typography.Text>
          <Space size={[6, 6]} wrap className="instance-bulk-name-list">
            {activeBatchPlan.eligible.slice(0, 8).map((item) => <Tag key={item.id}>{item.name}{rowActionInstance ? <> · {translateCode(t, item.status)}</> : null}</Tag>)}
            {activeBatchPlan.eligible.length > 8 && <Tag>{t('batchMoreInstances', { count: activeBatchPlan.eligible.length - 8 })}</Tag>}
          </Space>
        </div>
        {activeBatchPlan.skipped.length > 0 && <Alert type="info" showIcon message={t('batchSkippedTitle', { count: activeBatchPlan.skipped.length })} description={t('batchSkippedConfirmHint')} />}
        {bulkRequestError && <Alert type="error" showIcon message={rowActionInstance ? t('instanceActionRequestFailed', { action: bulkAction ? t(bulkAction) : '' }) : t('batchRequestFailed')} description={<div className="instance-action-request-error"><Typography.Text>{bulkRequestError}</Typography.Text>{rowActionInstance && <Typography.Text type="secondary">{t('instanceActionRequestFailedHint')}</Typography.Text>}</div>} />}
      </div>
    </Modal>
    <Drawer title={t('createInstance')} open={drawer} onClose={closeCreate} closable={!creating} maskClosable={!creating} width={compactLayout ? '100%' : 720} destroyOnClose footer={<div className="workflow-drawer-footer"><Button disabled={creating} onClick={closeCreate}>{t('cancel')}</Button><Space><Button icon={<LeftOutlined />} disabled={creating || step === 0} onClick={() => { setCreateFailure(undefined); setStep((value) => Math.max(0, value - 1)) }}>{t('previous')}</Button><Button type="primary" loading={creating} disabled={(step === 0 && !!selected && compatibleHosts.length === 0) || (step === 1 && resourceRequestReady && capacityCandidates.length === 0) || (step === 2 && !!createFailure && !createRetryAllowed)} onClick={step === 2 ? () => void create() : () => void next()}>{step === 2 ? t('create') : t('next')}</Button></Space></div>}>{compactLayout ? <div className="wizard-mobile-progress"><div><Typography.Text type="secondary">{t('wizardStepProgress', { current: step + 1, total: createSteps.length })}</Typography.Text><Typography.Text strong>{createSteps[step].title}</Typography.Text></div><Progress percent={(step + 1) * 100 / createSteps.length} showInfo={false} size="small" /></div> : <Steps current={step} size="small" responsive={false} items={createSteps} />}
      <Form form={form} layout="vertical" requiredMark={false} className="wizard-form" onValuesChange={() => setCreateDraftDirty(true)}>
      {step === 0 && <>
        {frequentVersions.length > 0 && <section className="frequent-template-versions" aria-label={t('frequentTemplateVersions')}>
          <div className="frequent-template-versions-header">
            <Typography.Text strong>{t('frequentTemplateVersions')}</Typography.Text>
            <Typography.Text type="secondary">{t('frequentTemplateVersionsHint')}</Typography.Text>
          </div>
          <div className="frequent-template-version-grid">
            {frequentVersions.map(({ template, version }) => {
              const displayName = localizedTemplateText(template.name, template.nameZh, i18n.language)
              const selectedFrequentlyUsed = selectedVersionID === version.id
              return <Button
                key={version.id}
                className={`frequent-template-version${selectedFrequentlyUsed ? ' is-selected' : ''}`}
                aria-pressed={selectedFrequentlyUsed}
                aria-label={t('selectFrequentTemplateVersion', { name: displayName, version: version.version, count: version.deploymentCount || 0 })}
                onClick={() => chooseTemplateVersion(version.id)}
              >
                <DatabaseIcon slug={template.slug} name={displayName} size="small" />
                <span className="frequent-template-version-copy">
                  <strong>{displayName} {version.version}</strong>
                  <small>{t('historicalDeploymentCount', { count: version.deploymentCount || 0 })}</small>
                </span>
                {selectedFrequentlyUsed && <CheckCircleOutlined className="frequent-template-version-check" />}
              </Button>
            })}
          </div>
        </section>}
        <Form.Item name="templateVersionId" label={`${t('template')} / ${t('version')}`} rules={[{ required: true }]}><Select showSearch optionFilterProp="searchText" options={versionOptions} size="large" onChange={chooseTemplateVersion} optionRender={(option) => <Space><DatabaseIcon slug={option.data.template.slug} name={option.data.template.name} size="small" /><span>{option.label}</span></Space>} labelRender={({ value, label }) => { const option = versionOptions.find((item) => item.value === value); return option ? <Space><DatabaseIcon slug={option.template.slug} name={option.template.name} size="small" /><span>{option.label}</span></Space> : label }} /></Form.Item>
        {selected && <Card><Space align="start"><DatabaseIcon slug={selected.template.slug} name={selected.template.name} /><div><Typography.Title level={4}>{selected.template.name}</Typography.Title><Typography.Paragraph type="secondary">{t(`templateDescription_${selected.template.slug}`, { defaultValue: selected.template.description })}</Typography.Paragraph><Space wrap><StatusTag value={selected.template.tier} />{selected.version.architectures.map((a) => <Tag key={a}>{a}</Tag>)}{mvpTemplateImageReferences(selected.version).map((reference) => <Tag key={reference}>{reference}</Tag>)}</Space></div></Space></Card>}
        {selected && compatibleHosts.length === 0 && <Alert className="wizard-readiness-alert" type="warning" showIcon message={t('noCompatibleHosts')} description={t('noCompatibleHostsHint', { architectures: selected.version.architectures.join(' / ') })} action={<Button size="small" onClick={addRequiredHost}>{t('addHost')}</Button>} />}
        <Form.Item name="name" label={t('databaseNameLabel')} extra={t('databaseNameHint')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input size="large" maxLength={120} placeholder={t('databaseNamePlaceholder')} /></Form.Item>
      </>}
      {step === 1 && <>
        {selectedResourceProfiles.length > 0 && <Form.Item label={t('resourcePreset')}><Radio.Group className="wizard-choice-group wizard-resource-profiles" optionType="button" buttonStyle="solid" value={activeResourceProfile?.name} onChange={(event) => { const profile = selectedResourceProfiles.find((item) => item.name === event.target.value); if (profile) form.setFieldsValue({ cpu: profile.cpu, memoryGiB: profile.memoryBytes / 1024 ** 3, diskGiB: profile.diskBytes / 1024 ** 3 }) }} options={selectedResourceProfiles.map((profile) => ({ value: profile.name, label: <span className="wizard-resource-profile-label"><strong>{localizedTemplateText(profile.label, profile.labelZh, i18n.language) || t(`resourceProfile_${profile.name}`, { defaultValue: profile.name })}</strong><small>{profile.cpu} CPU · {bytes(profile.memoryBytes)} · {bytes(profile.diskBytes)}</small></span> }))} /></Form.Item>}
        <Row gutter={[16, 0]}><Col xs={24} sm={8}><Form.Item name="cpu" label={t('cpu')} rules={[{ required: true }]}><InputNumber min={selected?.version.minCpu ?? .25} step={.25} style={{ width: '100%' }} /></Form.Item></Col><Col xs={24} sm={8}><Form.Item name="memoryGiB" label={`${t('memory')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minMemoryBytes ?? 0) / 1024 ** 3} step={.5} style={{ width: '100%' }} /></Form.Item></Col><Col xs={24} sm={8}><Form.Item name="diskGiB" label={`${t('disk')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minDiskBytes ?? 0) / 1024 ** 3} style={{ width: '100%' }} /></Form.Item></Col></Row>
        <Typography.Paragraph type="secondary">{t('diskReservationHint')}</Typography.Paragraph>
        <Form.Item name="hostId" className="wizard-host-select" label={t('deploymentHost')} tooltip={t('autoHostTooltip')}>
          <Select
            allowClear
            showSearch
            optionFilterProp="searchText"
            placeholder={t('autoSelect')}
            options={deploymentHostOptions}
            labelRender={({ value, label }) => deploymentHostOptions.find((option) => option.value === value)?.host.name || label}
            optionRender={(option) => <div className={`deployment-host-option${option.data.disabled ? ' is-unavailable' : ''}`}>
              <div className="deployment-host-option-heading"><strong>{option.data.host.name}</strong><span>{option.data.host.architecture}</span></div>
              <small>{option.data.detail}</small>
            </div>}
          />
        </Form.Item>
        {resourceRequestReady && <Alert className="wizard-capacity-alert" type={capacityCandidates.length ? 'success' : 'warning'} showIcon message={capacityCandidates.length ? selectedHost ? t('selectedHostCapacityReady', { name: selectedHost.name }) : t('automaticHostCapacityReady', { fit: capacityCandidates.length, total: resourceHostScope.length }) : t('hostCapacityUnavailable')} description={capacityRemaining && capacityPreviewHost ? t('hostCapacityPreview', { name: capacityPreviewHost.name, cpu: capacityRemaining.cpu.toFixed(capacityRemaining.cpu % 1 ? 1 : 0), memory: bytes(capacityRemaining.memory), disk: bytes(capacityRemaining.disk) }) : t('hostCapacityUnavailableHint')} />}
        {selectedTemplateParameters.length > 0 && <Card size="small" title={t('templateParameters')}><Typography.Paragraph type="secondary">{t('templateParametersHint')}</Typography.Paragraph>{selectedTemplateParameters.map((parameter) => <Form.Item key={parameter.key} name={['templateParameters', parameter.key]} label={localizedTemplateText(parameter.label, parameter.labelZh, i18n.language)} extra={localizedTemplateText(parameter.description, parameter.descriptionZh, i18n.language)} valuePropName={parameter.type === 'boolean' ? 'checked' : 'value'} rules={[parameterRequiredRule(parameter)]}>{parameterInput(parameter)}</Form.Item>)}</Card>}
        <Alert className="wizard-public-image-note" type="info" showIcon message={t('mvpPublicImageTitle')} description={selected ? mvpTemplateImageReferences(selected.version).join(' · ') : undefined} />
      </>}
      {step === 2 && <div className="create-review">
        <div className="create-review-header">
          <DatabaseIcon slug={selected?.template.slug || 'database'} name={selected?.template.name || t('database')} />
          <div>
            <Typography.Title level={4}>{form.getFieldValue('name')}</Typography.Title>
            <Space size={[6, 6]} wrap>
              <Typography.Text type="secondary">{selected ? `${selected.template.name} ${selected.version.version}` : '—'}</Typography.Text>
            </Space>
          </div>
          <CheckCircleOutlined className="create-review-ready-icon" />
        </div>
        {selectedAuthentication !== 'password' && <Alert className="wizard-authentication-alert" type="warning" showIcon message={t('nonPasswordAuthenticationTitle')} description={t(`nonPasswordAuthenticationHint_${selectedAuthentication}`)} />}
        <div className="create-review-grid">
          <Card size="small" className="create-review-card" title={t('deploymentTarget')}>
            <Descriptions column={1} colon={false} items={[
              { key: 'host', label: t('host'), children: selectedHost?.name || (capacityPreviewHost ? t('recommendedHost', { name: capacityPreviewHost.name }) : t('autoSelectWithCapacity', { count: capacityCandidates.length })) },
              { key: 'resources', label: t('resources'), children: `${form.getFieldValue('cpu')} CPU · ${form.getFieldValue('memoryGiB')} GiB · ${form.getFieldValue('diskGiB')} GiB` },
            ]} />
          </Card>
          <Card size="small" className="create-review-card" title={t('databaseAccess')}>
            <Descriptions column={1} colon={false} items={[
              { key: 'authentication', label: t('authentication'), children: t(`authenticationMode_${selectedAuthentication}`) },
              { key: 'database', label: t('databaseName'), children: selected?.version.manifest.database || '—' },
              ...(selectedAuthentication !== 'none' ? [{ key: 'username', label: t('username'), children: selected?.version.manifest.username || '—' }] : []),
              ...(selectedAuthentication === 'password' ? [{ key: 'password', label: t('password'), children: t('passwordGeneratedAfterCreate') }] : []),
              { key: 'image', label: t('imageSource'), children: t('publicRegistry') },
            ]} />
          </Card>
        </div>
        {selectedTemplateParameters.length > 0 && <Card size="small" className="create-review-card create-review-options" title={t('templateParameters')}><Space wrap>{selectedTemplateParameters.map((parameter) => <Tag key={parameter.key}>{localizedTemplateText(parameter.label, parameter.labelZh, i18n.language)}: {displayTemplateParameterValue(parameter, submittedTemplateParameters?.[parameter.key], i18n.language, t('enabled'), t('disabled'))}</Tag>)}</Space></Card>}
        <Alert className="create-review-alert" type="info" showIcon message={t('configurationReady')} description={t('createTaskHint')} />
        {createFailure && <Alert
          className="wizard-submit-error instance-create-request-alert"
          type="error"
          showIcon
          message={t('instanceCreateFailed')}
          description={<div className="instance-create-request-description">
            <Typography.Text>{createFailure.message}</Typography.Text>
            <div><strong>{t('failureImpact')}</strong><span>{t(createFailure.existingInstanceId ? 'instanceCreateExistingImpact' : createFailure.serverRejected ? 'instanceCreateRejectedImpact' : 'instanceCreateAmbiguousImpact')}</span></div>
            <div><strong>{t('recoveryAdvice')}</strong><span>{t(instanceCreateRecoveryKey(createFailure), { name: createFailure.existingInstanceName || form.getFieldValue('name') })}</span></div>
            <div><strong>{t('requestErrorCode')}</strong><Typography.Text code>{createFailure.code}</Typography.Text></div>
            <Typography.Text type="secondary">{t(createFailure.contextStatus === 'checking'
              ? 'instanceCreateContextChecking'
              : createFailure.contextStatus === 'failed'
                ? 'instanceCreateContextFailed'
                : createFailure.existingInstanceId
                  ? 'instanceCreateContextExisting'
                  : createRetryAllowed
                    ? 'instanceCreateContextRetryReady'
                    : 'instanceCreateContextReviewRequired')}</Typography.Text>
          </div>}
          action={<Space className="instance-create-request-actions" size={[8, 8]} wrap>
            {createFailure.existingInstanceId && <Button size="small" type="primary" onClick={() => { const id = createFailure.existingInstanceId; finishCloseCreate(); navigate(`/instances/${id}`) }}>{t('openExistingInstance')}</Button>}
            {!createFailure.existingInstanceId && createRecoveryStep < 2 && <Button size="small" type="primary" onClick={() => { setCreateFailure(undefined); setStep(createRecoveryStep) }}>{t(`reviewCreateStep_${createRecoveryStep}`)}</Button>}
            <Button size="small" icon={<ReloadOutlined />} loading={refreshingCreateContext} onClick={() => void refreshCreateContext()}>{t('refreshDeploymentContext')}</Button>
          </Space>}
        />}
      </div>}
    </Form></Drawer>
  </>
}

interface Connection { address: string; port: number; username: string; password: string; database: string; authentication: 'password' | 'username' | 'none'; uri: string; jdbc?: string }

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
