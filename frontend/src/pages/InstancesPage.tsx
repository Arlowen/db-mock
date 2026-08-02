import { CheckCircleOutlined, ClockCircleOutlined, CloudServerOutlined, CloseCircleOutlined, ControlOutlined, CopyOutlined, DeleteOutlined, EditOutlined, ExportOutlined, EyeInvisibleOutlined, LeftOutlined, LockOutlined, MoreOutlined, PauseCircleOutlined, PlayCircleOutlined, PlusOutlined, ReloadOutlined, RocketOutlined, SafetyCertificateOutlined, SaveOutlined, UndoOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, AutoComplete, Button, Card, Col, DatePicker, Descriptions, Drawer, Dropdown, Form, Grid, Input, InputNumber, Modal, Popconfirm, Progress, Radio, Row, Select, Space, Steps, Switch, Table, Tabs, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import type { TFunction } from 'i18next'
import { type Key, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import { InstanceCleanupReviewModal } from '../components/InstanceCleanupReview'
import { RestoreVerificationFacts } from '../components/RestoreVerificationFacts'
import { TaskFailureGuidance } from '../components/TaskFailureGuidance'
import { InstanceLifecycleTag } from '../components/InstanceLifecycle'
import { TaskRetryRequestRecovery } from '../components/TaskRetryRequestRecovery'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import appI18n from '../i18n'
import { ApiError, api, errorMessage } from '../lib/api'
import { failedBackupDeleteRecoveries } from '../lib/backup-delete-recovery'
import { backupRequestRecoveryKey, canRetryBackupRequest, type BackupRequestAction } from '../lib/backup-request-recovery'
import { cleanupContinuationPhase, cleanupEvidenceState, hasActiveBackupOperation, type CleanupEvidenceState } from '../lib/cleanup-continuation'
import { connectionHandoffSummary } from '../lib/connection-handoff'
import { deploymentReturnPathForHost } from '../lib/deployment-continuation'
import { frequentTemplateVersions } from '../lib/frequent-template-versions'
import { hostCanAccept, hostCanReconfigure, hostDeploymentReadiness, hostHeadroomScore, remainingAfterDeployment, reservationForHost } from '../lib/host-capacity'
import { imageArtifactMatchesTemplate, imageArtifactSupportsAnyArchitecture, imageRegistryHost, imageSourceSelectionReady, registryMatchesTemplate, templateImageReferences } from '../lib/image-source'
import { deploymentCopyDraft } from '../lib/instance-copy'
import { instanceTemplateDraftAction } from '../lib/instance-create-draft'
import { canRetryInstanceCreateRequest, instanceCreateRecoveryKey, type InstanceCreateRequestFailure } from '../lib/instance-create-recovery'
import { canRetryInstanceChangeRequest, instanceChangeRequestImpactKey, instanceChangeRequestRecoveryKey, isInstanceChangeRequestAction, type InstanceChangeRequestFailure } from '../lib/instance-change-request-recovery'
import { instanceHandoffAvailability, instanceHandoffRestoreVerification } from '../lib/instance-handoff'
import { instanceBatchActionPlan, instanceBatchTaskGroups, instanceListActions, type InstanceBatchAccepted, type InstanceBatchAction, type InstanceBatchActionResponse, type InstanceBatchActionResult, type InstanceBatchRejected } from '../lib/instance-actions'
import { canRetryInstanceLifecycleAction, instanceLifecycleRequestRecoveryKey, isInstanceLifecycleAction, type InstanceLifecycleAction } from '../lib/instance-operation-recovery'
import { formatCompactDateTime, formatDateTime, formatTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { hasProjectDeploymentProfile, hasProjectLifecycleDefaults, parseLabelText, projectDeploymentProfileMatches, projectDeploymentProfileValues, projectDeploymentValues } from '../lib/project-deployment-defaults'
import { restoreOutcome } from '../lib/restore-outcome'
import { latestRestoreTask, restoreVerification } from '../lib/restore-verification'
import { taskFailureGuidance } from '../lib/task-failure'
import { taskHostRecoveryPath, taskHostRecoveryPathForTask } from '../lib/task-recovery'
import { canCancelTask, canReviewIncompleteDeploymentCleanup, deploymentTaskNextStep, isRecoverableInstanceStatus, isTaskCancellationPending, selectDeploymentHandoff, selectRecoveryTasks } from '../lib/task-state'
import { useTaskNotification } from '../lib/task-notification'
import { useTaskRetryRequest } from '../lib/use-task-retry-request'
import { templateAuthentication } from '../lib/template-authentication'
import { displayTemplateParameterValue, localizedTemplateText, templateParameterDefaults, templateParameters, templateResourceProfiles } from '../lib/template-options'
import { commonTimezones, isValidTimezone } from '../lib/timezone'
import type { DatabaseTemplate, Host, ImageArtifact, Instance, InstanceBackup, InstanceBackupPolicy, Project, Registry, Task, TemplateParameter, TemplateParameterValue } from '../lib/types'
import { bytes } from '../lib/types'

type ImageSource = 'public' | 'registry' | 'offline'

interface CreateValues { name: string; projectId?: string; environment: string; purpose?: string; owner: string; expiresAt?: Dayjs; templateVersionId: string; hostId?: string; cpu: number; memoryGiB: number; diskGiB: number; hostPort?: number; bindAddress: string; username?: string; password?: string; databaseName?: string; autoRestart: boolean; imageSource: ImageSource; imageArtifactId?: string; registryId?: string; labels?: string; extraEnvironment?: string; templateParameters?: Record<string, TemplateParameterValue> }
interface EditValues { name: string; projectId?: string; environment: string; purpose?: string; owner: string; expiresAt?: Dayjs; labels?: string }
interface RuntimeValues { cpu: number; memoryGiB: number; diskGiB: number; extraEnvironment: string; autoRestart: boolean }
interface BackupPolicyValues { enabled: boolean; frequency: 'daily' | 'weekly'; weekday: number; hour: number; minute: number; timezone: string; retentionCount: number }

function selectableTemplateVersion(templates: DatabaseTemplate[], versionID?: string) {
  if (!versionID) return undefined
  return templates.flatMap((template) => template.versions).find((version) => version.id === versionID && version.selectable !== false)
}

function parseStringMap(value?: string): Record<string, string> | undefined {
  try {
    const parsed = JSON.parse(value?.trim() || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((item) => typeof item === 'string') ? parsed : undefined
  } catch { return undefined }
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>) {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key])
}

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
  projectName: string | undefined,
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
    project: projectName || t('noProject'),
    environment: translateCode(t, item.environment),
    purpose: item.purpose || t('purposeMissing'),
    owner: item.owner || t('ownerMissing'),
    expectedExpiry: item.expiresAt ? formatDateTime(item.expiresAt, language, timezone) : t('retainIndefinitely'),
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
    project: t('project'),
    environment: t('environment'),
    purpose: t('purpose'),
    owner: t('owner'),
    expectedExpiry: t('expectedExpiry'),
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
  const { t, i18n } = useTranslation(); const { message, modal } = App.useApp(); const navigate = useNavigate(); const notifyTask = useTaskNotification(); const [params, setParams] = useSearchParams(); const [items, setItems] = useState<Instance[]>([]); const [templates, setTemplates] = useState<DatabaseTemplate[]>([]); const [hosts, setHosts] = useState<Host[]>([]); const [projects, setProjects] = useState<Project[]>([]); const [images, setImages] = useState<ImageArtifact[]>([]); const [registries, setRegistries] = useState<Registry[]>([]); const [loading, setLoading] = useState(true); const [loadError, setLoadError] = useState(''); const [supportingDataError, setSupportingDataError] = useState(''); const [creationDataReady, setCreationDataReady] = useState(false); const [creating, setCreating] = useState(false); const [refreshingSources, setRefreshingSources] = useState(false); const [refreshingCreateContext, setRefreshingCreateContext] = useState(false); const [createDraftDirty, setCreateDraftDirty] = useState(false); const [createFailure, setCreateFailure] = useState<InstanceCreateRequestFailure>(); const [copySource, setCopySource] = useState<Instance>(); const copyPrefillApplied = useRef(false); const initializedTemplateVersionID = useRef(''); const [drawer, setDrawer] = useState(false); const [step, setStep] = useState(0); const [search, setSearch] = useState(''); const [projectFilter, setProjectFilter] = useState(() => params.get('project') || ''); const [hostFilter, setHostFilter] = useState(''); const [environmentFilter, setEnvironmentFilter] = useState(''); const [statusFilter, setStatusFilter] = useState(''); const [page, setPage] = useState(1); const [pageSize, setPageSize] = useState(20); const [form] = Form.useForm<CreateValues>()
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
  const lifecycleDefaults = useMemo(() => ({ owner: user?.displayName?.trim() || user?.username || '', expiresAt: dayjs().add(7, 'day').endOf('day') }), [user?.displayName, user?.username])
  const [appliedProjectDefaultsID, setAppliedProjectDefaultsID] = useState('')
  const screens = Grid.useBreakpoint()
  const compactLayout = screens.md === false
  const load = useCallback(async () => {
    const [instanceResponse, templateResponse, hostResponse, projectResponse, imageResponse, registryResponse] = await Promise.allSettled([
      api<{ items: Instance[] }>('/instances'),
      api<{ items: DatabaseTemplate[] }>('/templates'),
      api<{ items: Host[] }>('/hosts'),
      api<{ items: Project[] }>('/projects'),
      api<{ items: ImageArtifact[] }>('/images'),
      api<{ items: Registry[] }>('/registries'),
    ])
    if (instanceResponse.status === 'fulfilled') setItems(instanceResponse.value.items)
    if (templateResponse.status === 'fulfilled') setTemplates(templateResponse.value.items)
    if (hostResponse.status === 'fulfilled') setHosts(hostResponse.value.items)
    if (projectResponse.status === 'fulfilled') setProjects(projectResponse.value.items)
    if (imageResponse.status === 'fulfilled') setImages(imageResponse.value.items)
    if (registryResponse.status === 'fulfilled') setRegistries(registryResponse.value.items)
    setLoadError(instanceResponse.status === 'rejected' ? errorMessage(instanceResponse.reason) : '')
    const supportingFailure = [templateResponse, hostResponse, projectResponse, imageResponse, registryResponse].find((result) => result.status === 'rejected')
    setSupportingDataError(supportingFailure?.status === 'rejected' ? errorMessage(supportingFailure.reason) : '')
    setCreationDataReady(templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled')
    setLoading(false)
  }, [])
  const refreshImageSources = async () => {
    try {
      setRefreshingSources(true)
      const [imageResponse, registryResponse] = await Promise.allSettled([
        api<{ items: ImageArtifact[] }>('/images'),
        api<{ items: Registry[] }>('/registries'),
      ])
      if (imageResponse.status === 'fulfilled') setImages(imageResponse.value.items)
      if (registryResponse.status === 'fulfilled') setRegistries(registryResponse.value.items)
      const failure = [imageResponse, registryResponse].find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        message.error(errorMessage(failure.reason))
        return
      }
      message.success(t('imageSourcesRefreshed'))
    } finally {
      setRefreshingSources(false)
    }
  }
  const hasOnlineHost = hosts.some((host) => host.status === 'online' && !host.maintenance)
  const createRequested = params.get('create') === '1'
  const requestedCopyID = params.get('copy')
  const requestedTemplateID = params.get('template')
  const requestedImageID = params.get('image')
  const requestedHostID = params.get('host')
  const requestedProjectFilter = params.get('project') || ''
  const requestedProject = projects.find((project) => project.id === requestedProjectFilter)
  const requestedProjectProfile = useMemo(() => projectDeploymentProfileValues(requestedProject), [requestedProject])
  const requestedProjectVersion = selectableTemplateVersion(templates, requestedProjectProfile?.templateVersionId)
  const requestedProjectProfileAvailable = !!requestedProjectProfile && !!requestedProjectVersion
  const requestedCopySource = requestedCopyID ? items.find((item) => item.id === requestedCopyID) : undefined
  const requestedCopyTemplateAvailable = !!requestedCopySource && templates.some((template) => template.versions.some((version) => version.id === requestedCopySource.templateVersionId && version.selectable !== false))
  const requestedCopySourceUnavailable = !!requestedCopyID && !requestedCopySource
  const requestedCopyTemplateUnavailable = !!requestedCopySource && !requestedCopyTemplateAvailable
  const requestedTemplateAvailable = !!requestedTemplateID && templates.some((template) => template.versions.some((version) => version.id === requestedTemplateID && version.selectable !== false))
  const requestedVersion = templates.flatMap((template) => template.versions).find((version) => version.id === requestedTemplateID && version.selectable !== false)
  const requestedCopyVersion = requestedCopySource ? templates.flatMap((template) => template.versions).find((version) => version.id === requestedCopySource.templateVersionId && version.selectable !== false) : undefined
  const requestedCreationVersion = requestedCopyTemplateAvailable ? requestedCopyVersion : requestedVersion || requestedProjectVersion
  const requestedImage = images.find((image) => image.id === requestedImageID)
  const requestedImageAvailable = !!requestedVersion && !!requestedImage && requestedImage.status === 'ready' && imageArtifactMatchesTemplate(requestedImage.imageRefs, requestedVersion) && imageArtifactSupportsAnyArchitecture(requestedImage.architectures, requestedVersion.architectures)
  const requestedCompatibleHosts = hosts.filter((host) => host.status === 'online' && !host.maintenance && (!requestedCreationVersion || requestedCreationVersion.architectures.includes(host.architecture || '')) && (!requestedImageAvailable || imageArtifactSupportsAnyArchitecture(requestedImage.architectures, [host.architecture || ''])))
  const requestedImageHostAvailable = requestedImageAvailable && requestedCompatibleHosts.length > 0
  const requestedHost = requestedHostID ? hosts.find((host) => host.id === requestedHostID) : undefined
  const requestedHostReady = !!requestedHost && requestedCompatibleHosts.some((host) => host.id === requestedHost.id)
  const createIntent = useCallback(() => {
    const path = `/instances?create=1${requestedCopyID ? `&copy=${encodeURIComponent(requestedCopyID)}` : requestedTemplateID ? `&template=${encodeURIComponent(requestedTemplateID)}` : ''}${!requestedCopyID && requestedImageID ? `&image=${encodeURIComponent(requestedImageID)}` : ''}${requestedProjectFilter ? `&project=${encodeURIComponent(requestedProjectFilter)}` : ''}`
    return deploymentReturnPathForHost(path, requestedHostID)
  }, [requestedCopyID, requestedHostID, requestedImageID, requestedProjectFilter, requestedTemplateID])
  const addRequiredHost = useCallback(() => navigate(`/hosts?create=1&returnTo=${encodeURIComponent(createIntent())}`), [createIntent, navigate])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const available = new Set(items.map((item) => item.id))
    setSelectedInstanceIDs((current) => current.filter((id) => available.has(id)))
  }, [items])
  useEffect(() => { if (!drawer) setProjectFilter(requestedProjectFilter) }, [drawer, requestedProjectFilter])
  useEffect(() => {
    if (drawer || loading || loadError || !creationDataReady || !createRequested) return
    if (!canOperate) { setParams({}, { replace: true }); return }
    if (!requestedCopySourceUnavailable && !requestedCopyTemplateUnavailable && (requestedCreationVersion ? requestedCompatibleHosts.length === 0 : !hasOnlineHost)) { addRequiredHost(); return }
    if (requestedImageAvailable && !requestedImageHostAvailable) { addRequiredHost(); return }
    const source = requestedCopyTemplateAvailable ? requestedCopySource : undefined
    copyPrefillApplied.current = false
    initializedTemplateVersionID.current = ''
    setCopySource(source)
    setStep(source || requestedTemplateAvailable || requestedProjectProfileAvailable ? 1 : 0)
    setCreateFailure(undefined)
    setCreateDraftDirty(false)
    form.resetFields()
    form.setFieldsValue(source
      ? { ...deploymentCopyDraft(source, projects.map((project) => project.id)), ...lifecycleDefaults, hostId: requestedHostReady ? requestedHostID || undefined : undefined }
      : {
          bindAddress: '0.0.0.0',
          autoRestart: true,
          imageSource: requestedImageAvailable ? 'offline' : 'public',
          imageArtifactId: requestedImageAvailable ? requestedImageID || undefined : undefined,
          templateVersionId: requestedTemplateAvailable
            ? requestedTemplateID || undefined
            : requestedProjectProfileAvailable
              ? requestedProjectProfile.templateVersionId
              : undefined,
          projectId: requestedProjectFilter || undefined,
          ...lifecycleDefaults,
          ...projectDeploymentValues(requestedProject),
          ...(requestedProjectProfileAvailable ? requestedProjectProfile : {}),
          hostId: requestedHostReady ? requestedHostID || undefined : undefined,
        })
    setAppliedProjectDefaultsID(source ? '' : requestedProject?.id || '')
    setDrawer(true)
  }, [addRequiredHost, canOperate, createRequested, creationDataReady, drawer, form, hasOnlineHost, lifecycleDefaults, loadError, loading, projects, requestedCompatibleHosts.length, requestedCopySource, requestedCopySourceUnavailable, requestedCopyTemplateAvailable, requestedCopyTemplateUnavailable, requestedCreationVersion, requestedHostID, requestedHostReady, requestedImageAvailable, requestedImageHostAvailable, requestedImageID, requestedProject, requestedProjectFilter, requestedProjectProfile, requestedProjectProfileAvailable, requestedTemplateAvailable, requestedTemplateID, setParams])
  const selectedVersionID = Form.useWatch('templateVersionId', { form, preserve: true })
  const selectedProjectID = Form.useWatch('projectId', { form, preserve: true })
  const selectedHostID = Form.useWatch('hostId', { form, preserve: true })
  const selectedRegistryID = Form.useWatch('registryId', { form, preserve: true })
  const selectedImageArtifactID = Form.useWatch('imageArtifactId', { form, preserve: true })
  const imageSource = Form.useWatch('imageSource', { form, preserve: true }) || 'public'
  const requestedCPU = Form.useWatch('cpu', { form, preserve: true })
  const requestedMemoryGiB = Form.useWatch('memoryGiB', { form, preserve: true })
  const requestedDiskGiB = Form.useWatch('diskGiB', { form, preserve: true })
  const requestedHostPort = Form.useWatch('hostPort', { form, preserve: true })
  const submittedTemplateParameters = Form.useWatch('templateParameters', { form, preserve: true })
  const selected = useMemo(() => { for (const item of templates) for (const version of item.versions) if (version.id === selectedVersionID && version.selectable !== false) return { template: item, version }; return undefined }, [templates, selectedVersionID])
  const selectedAuthentication = selected ? templateAuthentication(selected.template, selected.version) : 'password'
  const frequentVersions = useMemo(() => frequentTemplateVersions(templates), [templates])
  const selectedProject = projects.find((project) => project.id === selectedProjectID)
  const selectedProjectProfile = useMemo(() => projectDeploymentProfileValues(selectedProject), [selectedProject])
  const selectedProjectProfileAvailable = !!selectedProjectProfile && !!selectableTemplateVersion(templates, selectedProjectProfile.templateVersionId)
  const selectedProjectProfileSelected = !copySource && selectedProjectProfileAvailable && selectedProjectProfile.templateVersionId === selectedVersionID
  const selectedProjectProfileApplied = selectedProjectProfileSelected && projectDeploymentProfileMatches(selectedProjectProfile, {
    templateVersionId: selectedVersionID,
    cpu: requestedCPU,
    memoryGiB: requestedMemoryGiB,
    diskGiB: requestedDiskGiB,
  })
  const selectedTemplateParameters = useMemo(() => templateParameters(selected?.version), [selected])
  const selectedResourceProfiles = useMemo(() => templateResourceProfiles(selected?.version), [selected])
  const templateCompatibleHosts = useMemo(() => hosts.filter((host) => host.status === 'online' && !host.maintenance && (!selected || selected.version.architectures.includes(host.architecture || ''))), [hosts, selected])
  const selectedHost = templateCompatibleHosts.find((host) => host.id === selectedHostID)
  const eligibleImageArchitectures = useMemo(() => selectedHost ? [selectedHost.architecture || ''] : templateCompatibleHosts.map((host) => host.architecture || ''), [selectedHost, templateCompatibleHosts])
  const compatibleImages = useMemo(() => images.filter((item) => item.status === 'ready' && !!selected && imageArtifactMatchesTemplate(item.imageRefs, selected.version) && imageArtifactSupportsAnyArchitecture(item.architectures, eligibleImageArchitectures)), [eligibleImageArchitectures, images, selected])
  const selectedImage = compatibleImages.find((item) => item.id === selectedImageArtifactID)
  const compatibleHosts = useMemo(() => imageSource === 'offline' && selectedImage ? templateCompatibleHosts.filter((host) => imageArtifactSupportsAnyArchitecture(selectedImage.architectures, [host.architecture || ''])) : templateCompatibleHosts, [imageSource, selectedImage, templateCompatibleHosts])
  const resourceRequest = useMemo(() => ({ cpu: requestedCPU || 0, memory: Math.round((requestedMemoryGiB || 0) * 1024 ** 3), disk: Math.round((requestedDiskGiB || 0) * 1024 ** 3), port: requestedHostPort || undefined }), [requestedCPU, requestedDiskGiB, requestedHostPort, requestedMemoryGiB])
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
        ? t(requestedHostPort ? 'hostOptionRemainingWithPort' : 'hostOptionRemaining', { cpu: readiness.remaining.cpu.toFixed(readiness.remaining.cpu % 1 ? 1 : 0), memory: bytes(readiness.remaining.memory), disk: bytes(readiness.remaining.disk), port: requestedHostPort })
        : t('hostOptionUnavailable', { issues, cpu: readiness.available.cpu.toFixed(readiness.available.cpu % 1 ? 1 : 0), memory: bytes(readiness.available.memory), disk: bytes(readiness.available.disk) })
    return { value: host.id, label: `${host.name} · ${detail}`, searchText: `${host.name} ${host.architecture}`, disabled: !!readiness && !readiness.fits, host, readiness, detail }
  })
  const compatibleRegistries = useMemo(() => registries.filter((registry) => !!selected && registryMatchesTemplate(registry.url, selected.version)), [registries, selected])
  const selectedRegistry = compatibleRegistries.find((registry) => registry.id === selectedRegistryID)
  const imageSourceReady = imageSourceSelectionReady(imageSource, selectedRegistryID, selectedImageArtifactID)
  const refreshCreateContext = async (failure = createFailure) => {
    if (!failure) return
    const values = form.getFieldsValue(true) as CreateValues
    setRefreshingCreateContext(true)
    setCreateFailure({ ...failure, contextStatus: 'checking', existingInstanceId: undefined, existingInstanceName: undefined })
    try {
      const [instanceResponse, templateResponse, hostResponse, projectResponse, imageResponse, registryResponse] = await Promise.allSettled([
        api<{ items: Instance[] }>('/instances'),
        api<{ items: DatabaseTemplate[] }>('/templates'),
        api<{ items: Host[] }>('/hosts'),
        api<{ items: Project[] }>('/projects'),
        api<{ items: ImageArtifact[] }>('/images'),
        api<{ items: Registry[] }>('/registries'),
      ])
      if (instanceResponse.status === 'fulfilled') setItems(instanceResponse.value.items)
      if (templateResponse.status === 'fulfilled') setTemplates(templateResponse.value.items)
      if (hostResponse.status === 'fulfilled') setHosts(hostResponse.value.items)
      if (projectResponse.status === 'fulfilled') setProjects(projectResponse.value.items)
      if (imageResponse.status === 'fulfilled') setImages(imageResponse.value.items)
      if (registryResponse.status === 'fulfilled') setRegistries(registryResponse.value.items)
      const coreReady = instanceResponse.status === 'fulfilled' && templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled'
      const relevantSourcesReady =
        (!values.projectId || projectResponse.status === 'fulfilled') &&
        (values.imageSource !== 'offline' || imageResponse.status === 'fulfilled') &&
        (values.imageSource !== 'registry' || registryResponse.status === 'fulfilled')
      const normalizedName = values.name?.trim().toLocaleLowerCase()
      const existing = instanceResponse.status === 'fulfilled' && normalizedName
        ? instanceResponse.value.items.find((item) => item.name.trim().toLocaleLowerCase() === normalizedName)
        : undefined
      setCreationDataReady(templateResponse.status === 'fulfilled' && hostResponse.status === 'fulfilled')
      setCreateFailure((current) => current ? {
        ...current,
        contextStatus: coreReady && relevantSourcesReady ? 'ready' : 'failed',
        existingInstanceId: existing?.id,
        existingInstanceName: existing?.name,
      } : current)
    } finally {
      setRefreshingCreateContext(false)
    }
  }
  const selectedProjectReady = !selectedProjectID || !!selectedProject
  const selectedHostReady = !selectedHostID || !!selectedHost
  const selectedImageSourceReady = imageSource === 'offline'
    ? !!selectedImage
    : imageSource === 'registry'
      ? !!selectedRegistry && !['offline', 'degraded'].includes(selectedRegistry.status)
      : true
  const createDraftReady = creationDataReady &&
    !!selected &&
    selectedProjectReady &&
    selectedHostReady &&
    resourceRequestReady &&
    capacityCandidates.length > 0 &&
    imageSourceReady &&
    selectedImageSourceReady
  const createRetryAllowed = !!createFailure && canRetryInstanceCreateRequest({
    ...createFailure,
    draftReady: createDraftReady,
  })
  const createRecoveryStep = !selected
    ? 0
    : !selectedProjectReady || createFailure?.code === 'invalid_input'
      ? 1
      : !resourceRequestReady || capacityCandidates.length === 0 || !selectedHostReady
        ? 2
        : !imageSourceReady || !selectedImageSourceReady
          ? 3
          : 4
  useEffect(() => {
    if (!selected) return
    const action = instanceTemplateDraftAction({
      initializedTemplateVersionId: initializedTemplateVersionID.current,
      selectedTemplateVersionId: selected.version.id,
      copySourceTemplateVersionId: copySource?.templateVersionId,
      copyPrefillApplied: copyPrefillApplied.current,
    })
    if (action === 'preserve' || action === 'wait') return
    initializedTemplateVersionID.current = selected.version.id
    if (action === 'copy' && copySource) {
      copyPrefillApplied.current = true
      const draft = deploymentCopyDraft(copySource, projects.map((project) => project.id))
      form.setFieldsValue({ ...draft, username: selectedAuthentication === 'none' ? '' : draft.username, password: undefined })
      return
    }
    const manifest = selected.version.manifest
    const profile = selectedResourceProfiles[0]
    form.setFieldsValue({
      cpu: selectedProjectProfileSelected ? selectedProjectProfile!.cpu : profile?.cpu ?? selected.version.minCpu,
      memoryGiB: selectedProjectProfileSelected ? selectedProjectProfile!.memoryGiB : (profile?.memoryBytes ?? selected.version.minMemoryBytes) / 1024 ** 3,
      diskGiB: selectedProjectProfileSelected ? selectedProjectProfile!.diskGiB : (profile?.diskBytes ?? selected.version.minDiskBytes) / 1024 ** 3,
      username: selectedAuthentication === 'none' ? '' : manifest.username,
      password: undefined,
      databaseName: manifest.database,
      templateParameters: templateParameterDefaults(selectedTemplateParameters),
    })
  }, [copySource, form, projects, selected, selectedAuthentication, selectedProjectProfile, selectedProjectProfileSelected, selectedResourceProfiles, selectedTemplateParameters])
  useEffect(() => {
    if (!selected) return
    if (selectedHostID && !templateCompatibleHosts.some((host) => host.id === selectedHostID)) form.setFieldValue('hostId', undefined)
    const imageArtifactID = form.getFieldValue('imageArtifactId')
    if (imageArtifactID && !compatibleImages.some((item) => item.id === imageArtifactID)) form.setFieldValue('imageArtifactId', undefined)
    const registryID = form.getFieldValue('registryId')
    if (registryID && !compatibleRegistries.some((registry) => registry.id === registryID)) form.setFieldValue('registryId', undefined)
  }, [compatibleImages, compatibleRegistries, form, selected, selectedHostID, templateCompatibleHosts])
  const activeResourceProfile = selectedResourceProfiles.find((profile) => profile.cpu === requestedCPU && profile.memoryBytes === Math.round((requestedMemoryGiB || 0) * 1024 ** 3) && profile.diskBytes === Math.round((requestedDiskGiB || 0) * 1024 ** 3))
  const applyProjectDefaults = (projectID?: string) => {
    const project = projects.find((candidate) => candidate.id === projectID)
    form.setFieldsValue(projectDeploymentValues(project))
    setAppliedProjectDefaultsID(project?.id || '')
  }
  const applyProjectDeploymentProfile = (projectID?: string) => {
    const project = projects.find((candidate) => candidate.id === projectID)
    const profile = projectDeploymentProfileValues(project)
    if (!profile || !selectableTemplateVersion(templates, profile.templateVersionId)) return
    setCopySource(undefined)
    copyPrefillApplied.current = false
    form.setFieldsValue(profile)
    setCreateDraftDirty(true)
  }
  const chooseTemplateVersion = (value: string) => {
    form.setFieldValue('templateVersionId', value)
    setCreateDraftDirty(true)
    if (copySource && value !== copySource.templateVersionId) {
      setCopySource(undefined)
      applyProjectDefaults(selectedProjectID)
    }
  }
  const openCreate = () => {
    if (!hasOnlineHost) { addRequiredHost(); return }
    const project = projects.find((candidate) => candidate.id === projectFilter)
    const profile = projectDeploymentProfileValues(project)
    const profileAvailable = !!profile && !!selectableTemplateVersion(templates, profile.templateVersionId)
    copyPrefillApplied.current = false
    initializedTemplateVersionID.current = ''
    setCopySource(undefined)
    setDrawer(true)
    setStep(profileAvailable ? 1 : 0)
    setCreateFailure(undefined)
    setCreateDraftDirty(false)
    setAppliedProjectDefaultsID(project?.id || '')
    form.resetFields()
    form.setFieldsValue({
      bindAddress: '0.0.0.0',
      autoRestart: true,
      imageSource: 'public',
      projectId: projectFilter || undefined,
      ...lifecycleDefaults,
      ...projectDeploymentValues(project),
      ...(profileAvailable ? profile : {}),
    })
  }
  const finishCloseCreate = () => { setDrawer(false); setParams(projectFilter ? { project: projectFilter } : {}, { replace: true }); setCopySource(undefined); setAppliedProjectDefaultsID(''); copyPrefillApplied.current = false; initializedTemplateVersionID.current = ''; setStep(0); setCreateFailure(undefined); setCreateDraftDirty(false); form.resetFields() }
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
    const fields: Array<keyof CreateValues> = step === 0 ? ['templateVersionId'] : step === 1 ? ['name', 'environment', 'owner', 'labels'] : step === 2 ? ['cpu', 'memoryGiB', 'diskGiB', 'bindAddress'] : step === 3 ? ['templateParameters', 'extraEnvironment', ...(imageSource === 'registry' ? ['registryId' as const] : imageSource === 'offline' ? ['imageArtifactId' as const] : [])] : []
    try {
      await form.validateFields(fields)
      if (step === 0 && compatibleHosts.length === 0) return
      if (step === 2 && capacityCandidates.length === 0) return
      if (step === 3 && !imageSourceReady) return
      if (step === 3 && imageSource === 'offline' && selectedImage && capacityCandidates.length === 0) return
      setCreateFailure(undefined)
      setStep(Math.min(step + 1, 4))
    } catch { /* form marks errors */ }
  }
  const create = async () => {
    try {
      setCreating(true)
      setCreateFailure(undefined)
      await form.validateFields()
      const values = form.getFieldsValue(true) as CreateValues
      const labels = parseLabelText(values.labels) || {}
      let extraEnvironment: Record<string, string> = {}
      if (values.extraEnvironment?.trim()) extraEnvironment = JSON.parse(values.extraEnvironment)
      const payload = { name: values.name, projectId: values.projectId || null, environment: values.environment, purpose: values.purpose?.trim() || '', owner: values.owner.trim(), expiresAt: values.expiresAt?.toISOString() || null, templateVersionId: values.templateVersionId, hostId: values.hostId || null, cpu: values.cpu, memoryBytes: Math.round(values.memoryGiB * 1024 ** 3), diskBytes: Math.round(values.diskGiB * 1024 ** 3), hostPort: values.hostPort || 0, bindAddress: values.bindAddress, username: selectedAuthentication === 'none' ? '' : values.username || '', password: selectedAuthentication === 'password' ? values.password || '' : '', databaseName: values.databaseName || '', autoRestart: values.autoRestart, imageArtifactId: values.imageSource === 'offline' ? values.imageArtifactId || null : null, registryId: values.imageSource === 'registry' ? values.registryId || null : null, labels, extraEnvironment, templateParameters: values.templateParameters || {} }
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
      const projectName = projects.find((project) => project.id === handoffItem.projectId)?.name
      await copyText(connectionHandoffText(handoffItem, projectName, connection, verification, t, i18n.language, timezone))
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
    const copyAvailable = templates.some((template) => template.versions.some((version) => version.id === item.templateVersionId && version.selectable !== false))
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
      {canOperate && <Button
        type="text"
        disabled={bulkSubmitting || !creationDataReady || !copyAvailable}
        aria-label={t('copyDeployment')}
        title={copyAvailable ? t('copyDeploymentForInstance', { name: item.name }) : t('copyDeploymentUnavailableHint')}
        icon={<CopyOutlined />}
        onClick={() => navigate(`/instances?create=1&copy=${encodeURIComponent(item.id)}`)}
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
    { title: t('environment'), dataIndex: 'environment', width: 125, render: (value: string) => <Tag>{translateCode(t, value)}</Tag> },
    { title: t('lifecycle'), width: 190, render: (_: unknown, item: Instance) => <div className="instance-lifecycle-cell"><Space size={4} wrap><InstanceLifecycleTag expiresAt={item.expiresAt} /></Space><Typography.Text type="secondary">{item.owner || t('ownerMissing')}</Typography.Text></div> },
    { title: '', align: 'right' as const, fixed: 'right' as const, width: 225, render: (_: unknown, item: Instance) => instanceActions(item) },
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
          <Tag>{translateCode(t, item.environment)}</Tag>
          <InstanceLifecycleTag expiresAt={item.expiresAt} />
          <Typography.Text type="secondary">{item.cpu} CPU · {bytes(item.memoryBytes)} · {bytes(item.reservedDiskBytes)}</Typography.Text>
        </Space>
        <Typography.Text type="secondary">{item.purpose || t('purposeMissing')} · {item.owner || t('ownerMissing')}</Typography.Text>
      </div>,
    },
  ]
  const columns = compactLayout ? mobileColumns : desktopColumns
  const versionOptions = templates.flatMap((item) => item.versions.filter((version) => version.selectable !== false).map((version) => ({ value: version.id, searchText: `${item.name} ${item.nameZh} ${version.version} ${templateImageReferences(version).join(' ')}`, label: `${item.name} ${version.version}`, template: item, version })))
  const filteredItems = useMemo(() => items.filter((item) => (!projectFilter || item.projectId === projectFilter) && (!hostFilter || item.hostId === hostFilter) && (!environmentFilter || item.environment === environmentFilter) && (!statusFilter || item.status === statusFilter) && `${item.name} ${item.templateName} ${item.hostName} ${item.purpose || ''} ${item.owner || ''} ${JSON.stringify(item.labels)}`.toLowerCase().includes(search.toLowerCase())), [items, projectFilter, hostFilter, environmentFilter, statusFilter, search])
  const hasFilters = !!(search || projectFilter || hostFilter || environmentFilter || statusFilter)
  const showFilters = items.length > 0 || hasFilters
  useEffect(() => {
    setSelectedInstanceIDs([])
    setBulkAction(undefined)
    setBulkRequestError('')
  }, [environmentFilter, hostFilter, projectFilter, search, statusFilter])
  const resetPage = () => setPage(1)
  const updateProjectFilter = (value: string) => {
    setProjectFilter(value)
    const next = new URLSearchParams(params)
    if (value) next.set('project', value)
    else next.delete('project')
    setParams(next, { replace: true })
    resetPage()
  }
  const clearFilters = () => {
    setSearch('')
    setProjectFilter('')
    setHostFilter('')
    setEnvironmentFilter('')
    setStatusFilter('')
    const next = new URLSearchParams(params)
    next.delete('project')
    setParams(next, { replace: true })
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
  const rowSelection = canOperate ? {
    selectedRowKeys: selectedInstanceIDs,
    preserveSelectedRowKeys: true,
    columnWidth: compactLayout ? 44 : 48,
    getCheckboxProps: () => ({ disabled: bulkSubmitting }),
    onChange: (keys: Key[]) => {
      setSelectedInstanceIDs(keys.map(String))
    },
  } : undefined
  const createSteps = [{ title: t('template') }, { title: t('basicInfo') }, { title: t('resources') }, { title: t('options') }, { title: t('confirm') }]
  const parameterInput = (parameter: TemplateParameter) => {
    if (parameter.type === 'number') return <InputNumber min={parameter.min} max={parameter.max} step={parameter.step} style={{ width: '100%' }} />
    if (parameter.type === 'boolean') return <Switch />
    if (parameter.type === 'select') return <Select options={(parameter.options || []).map((option) => ({ value: option.value, label: localizedTemplateText(option.label, option.labelZh, i18n.language) }))} />
    return <Input maxLength={4096} />
  }
  const parameterRequiredRule = (parameter: TemplateParameter) => ({ validator: (_: unknown, value: TemplateParameterValue | undefined) => !parameter.required || value !== undefined && (typeof value !== 'string' || value.trim() !== '') ? Promise.resolve() : Promise.reject(new Error(t('templateParameterRequired', { label: localizedTemplateText(parameter.label, parameter.labelZh, i18n.language) }))) })
  return <><PageHeader title={t('instances')} description={t('instancesDescription')} />
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('instanceListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {supportingDataError && <Alert className="instance-page-alert" type="warning" showIcon message={t('instanceSupportingDataLoadFailed')} description={supportingDataError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {showFilters && <Card className="table-filter-card instance-filter-card"><div className="instance-filter-toolbar"><Input.Search allowClear value={search} aria-label={t('instancesSearchLabel')} placeholder={t('instancesSearchPlaceholder')} onChange={(event) => { setSearch(event.target.value); resetPage() }} className="instance-filter-search" /><Select aria-label={t('project')} value={projectFilter} onChange={updateProjectFilter} className="instance-filter-project" options={[{ value: '', label: t('allProjects') }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} /><Select aria-label={t('host')} value={hostFilter} onChange={(value) => { setHostFilter(value); resetPage() }} className="instance-filter-host" options={[{ value: '', label: t('allHosts') }, ...hosts.map((host) => ({ value: host.id, label: host.name }))]} /><Select aria-label={t('environment')} value={environmentFilter} onChange={(value) => { setEnvironmentFilter(value); resetPage() }} className="instance-filter-environment" options={[{ value: '', label: t('allEnvironments') }, ...['development', 'testing', 'staging', 'production'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Select aria-label={t('status')} value={statusFilter} onChange={(value) => { setStatusFilter(value); resetPage() }} className="instance-filter-status" options={[{ value: '', label: t('allStatuses') }, ...['provisioning', 'running', 'stopped', 'degraded', 'failed', 'reconfiguring', 'backing_up', 'restoring'].map((value) => ({ value, label: translateCode(t, value) }))]} /><Typography.Text type="secondary" className="instance-filter-count" aria-live="polite">{hasFilters ? t('instanceFilteredResultCount', { filtered: filteredItems.length, total: items.length }) : t('instanceResultCount', { count: items.length })}</Typography.Text>{listActions}</div></Card>}
    {bulkToolbar}
    {bulkResultAlert}
    {(items.length > 0 || !loadError) && <Card className="instance-table-card" title={!showFilters ? t('instances') : undefined} extra={!showFilters ? listActions : undefined}><Table rowKey="id" loading={loading} rowSelection={rowSelection} dataSource={filteredItems} columns={columns} showHeader={!compactLayout} scroll={compactLayout ? undefined : { x: 1210 }} pagination={{ current: page, pageSize, showSizeChanger: !compactLayout, pageSizeOptions: [20, 50], onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize) } }} locale={{ emptyText: <EmptyState compact action={emptyAction} actionLabel={emptyActionLabel} description={emptyDescription} /> }} /></Card>}
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
          column={{ xs: 1, sm: 2 }}
          items={[
            { key: 'project', label: t('project'), children: projects.find((project) => project.id === handoffItem.projectId)?.name || t('noProject') },
            { key: 'environment', label: t('environment'), children: translateCode(t, handoffItem.environment) },
            { key: 'purpose', label: t('purpose'), span: 2, children: handoffItem.purpose || t('purposeMissing') },
            { key: 'owner', label: t('owner'), children: handoffItem.owner || t('ownerMissing') },
            { key: 'expiry', label: t('expectedExpiry'), children: handoffItem.expiresAt ? formatDateTime(handoffItem.expiresAt, i18n.language, timezone) : t('retainIndefinitely') },
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
    <Drawer title={copySource ? t('copyDeploymentTitle', { name: copySource.name }) : t('createInstance')} open={drawer} onClose={closeCreate} closable={!creating} maskClosable={!creating} width={compactLayout ? '100%' : 720} destroyOnClose footer={<div className="workflow-drawer-footer"><Button disabled={creating} onClick={closeCreate}>{t('cancel')}</Button><Space><Button icon={<LeftOutlined />} disabled={creating || step === 0} onClick={() => { setCreateFailure(undefined); setStep((value) => Math.max(0, value - 1)) }}>{t('previous')}</Button><Button type="primary" loading={creating} disabled={(step === 0 && !!selected && compatibleHosts.length === 0) || (step === 2 && resourceRequestReady && capacityCandidates.length === 0) || (step === 3 && (!imageSourceReady || (imageSource === 'offline' && !!selectedImage && capacityCandidates.length === 0))) || (step === 4 && !!createFailure && !createRetryAllowed)} onClick={step === 4 ? () => void create() : () => void next()}>{step === 4 ? t('create') : t('next')}</Button></Space></div>}>{compactLayout ? <div className="wizard-mobile-progress"><div><Typography.Text type="secondary">{t('wizardStepProgress', { current: step + 1, total: createSteps.length })}</Typography.Text><Typography.Text strong>{createSteps[step].title}</Typography.Text></div><Progress percent={(step + 1) * 100 / createSteps.length} showInfo={false} size="small" /></div> : <Steps current={step} size="small" responsive={false} items={createSteps} />}
      {copySource && <Alert className="copy-deployment-banner" type="success" showIcon message={t('copyDeploymentPrepared', { name: copySource.name })} description={t('copyDeploymentPreparedHint')} />}
      {requestedCopySourceUnavailable && <Alert className="copy-deployment-banner" type="warning" showIcon message={t('copyDeploymentSourceUnavailable')} description={t('copyDeploymentSourceUnavailableHint')} />}
      {requestedCopyTemplateUnavailable && <Alert className="copy-deployment-banner" type="warning" showIcon message={t('copyDeploymentTemplateUnavailable')} description={t('copyDeploymentTemplateUnavailableHint')} />}
      <Form form={form} layout="vertical" requiredMark={false} className="wizard-form" onValuesChange={() => setCreateDraftDirty(true)}>
      {step === 0 && <>
        {requestedProjectProfile && !requestedProjectProfileAvailable && <Alert
          className="project-defaults-banner"
          type="warning"
          showIcon
          message={t('projectDefaultTemplateUnavailable')}
          description={t('projectDefaultTemplateUnavailableHint', { name: requestedProject?.name })}
        />}
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
        {selected && <Card><Space align="start"><DatabaseIcon slug={selected.template.slug} name={selected.template.name} /><div><Typography.Title level={4}>{selected.template.name}</Typography.Title><Typography.Paragraph type="secondary">{t(`templateDescription_${selected.template.slug}`, { defaultValue: selected.template.description })}</Typography.Paragraph><Space wrap><StatusTag value={selected.template.tier} />{selected.version.architectures.map((a) => <Tag key={a}>{a}</Tag>)}{templateImageReferences(selected.version).map((reference) => <Tag key={reference}>{reference}</Tag>)}</Space></div></Space></Card>}
        {selected && compatibleHosts.length === 0 && <Alert className="wizard-readiness-alert" type="warning" showIcon message={t('noCompatibleHosts')} description={t('noCompatibleHostsHint', { architectures: selected.version.architectures.join(' / ') })} action={<Button size="small" onClick={addRequiredHost}>{t('addHost')}</Button>} />}
      </>}
      {step === 1 && <>
        {hasProjectLifecycleDefaults(selectedProject) && (copySource && appliedProjectDefaultsID !== selectedProject?.id
          ? <Alert className="project-defaults-banner" type="info" showIcon message={t('projectDefaultsAvailableForCopy', { name: selectedProject?.name })} description={t('projectDefaultsAvailableForCopyHint')} action={<Button size="small" onClick={() => applyProjectDefaults(selectedProject?.id)}>{t('applyProjectDefaults')}</Button>} />
          : <Alert className="project-defaults-banner" type="success" showIcon message={t('projectDefaultsApplied', { name: selectedProject?.name })} description={t('projectDefaultsAppliedHint')} />)}
        {hasProjectDeploymentProfile(selectedProject) && (selectedProjectProfileApplied
          ? <Alert
              className="project-defaults-banner"
              type="success"
              showIcon
              message={t('projectDeploymentProfileApplied', { name: selectedProject?.name })}
              description={t('projectDeploymentProfileAppliedHint', {
                template: `${selectedProject?.defaultTemplateName} ${selectedProject?.defaultTemplateVersion}`,
                cpu: selectedProjectProfile?.cpu,
                memory: bytes(selectedProject?.defaultMemoryBytes),
                disk: bytes(selectedProject?.defaultDiskBytes),
              })}
            />
          : selectedProjectProfileAvailable
            ? <Alert
                className="project-defaults-banner"
                type="info"
                showIcon
                message={t('projectDeploymentProfileAvailable', { name: selectedProject?.name })}
                description={t('projectDeploymentProfileAvailableHint', {
                  template: `${selectedProject?.defaultTemplateName} ${selectedProject?.defaultTemplateVersion}`,
                  cpu: selectedProjectProfile?.cpu,
                  memory: bytes(selectedProject?.defaultMemoryBytes),
                  disk: bytes(selectedProject?.defaultDiskBytes),
                })}
                action={<Button size="small" onClick={() => applyProjectDeploymentProfile(selectedProject?.id)}>{t('applyProjectDeploymentProfile')}</Button>}
              />
            : <Alert
                className="project-defaults-banner"
                type="warning"
                showIcon
                message={t('projectDefaultTemplateUnavailable')}
                description={t('projectDefaultTemplateUnavailableHint', { name: selectedProject?.name })}
              />)}
        {requestedHostID && requestedHostReady && selectedHostID === requestedHostID && <Alert className="host-continuation-selection" type="success" showIcon message={t('continuationHostSelected', { name: requestedHost?.name })} description={t('continuationHostSelectedHint')} />}
        {requestedHostID && !requestedHostReady && !selectedHostID && <Alert className="host-continuation-selection" type="warning" showIcon message={t('continuationHostUnavailable')} description={t('continuationHostUnavailableHint')} action={<Button size="small" onClick={addRequiredHost}>{t('addHost')}</Button>} />}
        <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input size="large" autoFocus maxLength={120} /></Form.Item>
        <Form.Item name="purpose" label={t('purpose')} extra={t('purposeHint')} rules={[{ max: 500 }]}><Input.TextArea rows={2} maxLength={500} showCount placeholder={t('purposePlaceholder')} /></Form.Item>
        <div className="form-grid"><Form.Item name="projectId" label={t('project')}><Select allowClear options={projects.map((p) => ({ value: p.id, label: p.name }))} onChange={(value) => { setAppliedProjectDefaultsID(''); if (!copySource) applyProjectDefaults(value) }} /></Form.Item><Form.Item name="environment" label={t('environment')} rules={[{ required: true }]}><Select options={['development', 'testing', 'staging', 'production'].map((v) => ({ value: v, label: translateCode(t, v) }))} /></Form.Item></div>
        <Card size="small" className="instance-lifecycle-form" title={t('lifecycle')}>
          <div className="form-grid">
            <Form.Item name="owner" label={t('owner')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} placeholder={t('ownerPlaceholder')} /></Form.Item>
            <Form.Item name="expiresAt" label={t('expectedExpiry')} extra={t('expectedExpiryHint')}><DatePicker showTime minuteStep={15} allowClear style={{ width: '100%' }} /></Form.Item>
          </div>
          <Space size={[8, 8]} wrap className="expiry-presets">
            <Typography.Text type="secondary">{t('quickSet')}</Typography.Text>
            {[1, 3, 7, 14, 30].map((days) => <Button key={days} size="small" onClick={() => form.setFieldValue('expiresAt', dayjs().add(days, 'day').endOf('day'))}>{t('daysCount', { count: days })}</Button>)}
            <Button size="small" onClick={() => form.setFieldValue('expiresAt', undefined)}>{t('retainIndefinitely')}</Button>
          </Space>
        </Card>
        <Form.Item name="labels" label={t('labels')} rules={[{ validator: (_, value?: string) => parseLabelText(value) ? Promise.resolve() : Promise.reject(new Error(t('invalidLabels'))) }]}><Input placeholder={t('labelsPlaceholder')} /></Form.Item>
      </>}
      {step === 2 && <>
        {selectedResourceProfiles.length > 0 && <Form.Item label={t('resourcePreset')}><Radio.Group className="wizard-choice-group wizard-resource-profiles" optionType="button" buttonStyle="solid" value={activeResourceProfile?.name} onChange={(event) => { const profile = selectedResourceProfiles.find((item) => item.name === event.target.value); if (profile) form.setFieldsValue({ cpu: profile.cpu, memoryGiB: profile.memoryBytes / 1024 ** 3, diskGiB: profile.diskBytes / 1024 ** 3 }) }} options={selectedResourceProfiles.map((profile) => ({ value: profile.name, label: <span className="wizard-resource-profile-label"><strong>{localizedTemplateText(profile.label, profile.labelZh, i18n.language) || t(`resourceProfile_${profile.name}`, { defaultValue: profile.name })}</strong><small>{profile.cpu} CPU · {bytes(profile.memoryBytes)} · {bytes(profile.diskBytes)}</small></span> }))} /></Form.Item>}
        <Row gutter={[16, 0]}><Col xs={24} sm={8}><Form.Item name="cpu" label={t('cpu')} rules={[{ required: true }]}><InputNumber min={selected?.version.minCpu ?? .25} step={.25} style={{ width: '100%' }} /></Form.Item></Col><Col xs={24} sm={8}><Form.Item name="memoryGiB" label={`${t('memory')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minMemoryBytes ?? 0) / 1024 ** 3} step={.5} style={{ width: '100%' }} /></Form.Item></Col><Col xs={24} sm={8}><Form.Item name="diskGiB" label={`${t('disk')} GiB`} rules={[{ required: true }]}><InputNumber min={(selected?.version.minDiskBytes ?? 0) / 1024 ** 3} style={{ width: '100%' }} /></Form.Item></Col></Row>
        <div className="form-grid"><Form.Item name="hostPort" label={`${t('port')} (${t('optional')})`}><InputNumber min={1} max={65535} style={{ width: '100%' }} placeholder={t('autoAllocate')} /></Form.Item><Form.Item name="bindAddress" label={t('bindAddress')} rules={[{ required: true }]}><Input /></Form.Item></div>
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
        {resourceRequestReady && <Alert className="wizard-capacity-alert" type={capacityCandidates.length ? 'success' : 'warning'} showIcon message={capacityCandidates.length ? selectedHost ? t('selectedHostCapacityReady', { name: selectedHost.name }) : t('automaticHostCapacityReady', { fit: capacityCandidates.length, total: resourceHostScope.length }) : t('hostCapacityUnavailable')} description={capacityRemaining && capacityPreviewHost ? t(requestedHostPort ? 'hostCapacityPreviewWithPort' : 'hostCapacityPreview', { name: capacityPreviewHost.name, cpu: capacityRemaining.cpu.toFixed(capacityRemaining.cpu % 1 ? 1 : 0), memory: bytes(capacityRemaining.memory), disk: bytes(capacityRemaining.disk), port: requestedHostPort }) : t('hostCapacityUnavailableHint')} />}
      </>}
      {step === 3 && <>{selectedTemplateParameters.length > 0 && <Card size="small" title={t('templateParameters')}><Typography.Paragraph type="secondary">{t('templateParametersHint')}</Typography.Paragraph>{selectedTemplateParameters.map((parameter) => <Form.Item key={parameter.key} name={['templateParameters', parameter.key]} label={localizedTemplateText(parameter.label, parameter.labelZh, i18n.language)} extra={localizedTemplateText(parameter.description, parameter.descriptionZh, i18n.language)} valuePropName={parameter.type === 'boolean' ? 'checked' : 'value'} rules={[parameterRequiredRule(parameter)]}>{parameterInput(parameter)}</Form.Item>)}</Card>}{selectedAuthentication !== 'password' && <Alert className="wizard-authentication-alert" type="warning" showIcon message={t('nonPasswordAuthenticationTitle')} description={t(`nonPasswordAuthenticationHint_${selectedAuthentication}`)} />}<div className="form-grid">{selectedAuthentication !== 'none' && <Form.Item name="username" label={t('username')}><Input /></Form.Item>}<Form.Item name="databaseName" label={t('databaseName')}><Input /></Form.Item></div>{selectedAuthentication === 'password' && <Form.Item name="password" label={t('password')} tooltip={t('passwordGenerateHint')}><Input.Password placeholder={t('automaticallyGenerated')} /></Form.Item>}<Form.Item name="imageSource" label={t('imageSource')}><Radio.Group className="wizard-choice-group" optionType="button" buttonStyle="solid" options={[{ value: 'public', label: t('publicRegistry') }, { value: 'registry', label: t('configuredRegistry') }, { value: 'offline', label: t('offlineImage') }]} onChange={() => { form.setFieldsValue({ imageArtifactId: undefined, registryId: undefined }); setCreateFailure(undefined) }} /></Form.Item>{imageSource === 'public' && <Alert type="info" showIcon message={t('pullTemplateImage')} description={selected ? templateImageReferences(selected.version).join(' · ') : undefined} />}{imageSource === 'registry' && <><Form.Item name="registryId" label={t('registry')} rules={[{ required: true }]}><Select placeholder={t('selectRegistryForHost', { host: selected ? imageRegistryHost(selected.version.imageReference) : '—' })} options={compatibleRegistries.map((registry) => ({ value: registry.id, disabled: ['offline', 'degraded'].includes(registry.status), label: <Space><span>{registry.name}</span><StatusTag value={registry.status} /></Space> }))} /></Form.Item>{compatibleRegistries.length === 0 ? <Alert type="warning" showIcon message={t('noMatchingRegistries')} description={<Space direction="vertical" size={2}><span>{t('noMatchingRegistriesHint', { host: selected ? imageRegistryHost(selected.version.imageReference || '') : '—' })}</span><span>{t('imageSourceSetupHint')}</span></Space>} action={<Space direction="vertical" size={4}><Button size="small" type="primary" icon={<ExportOutlined />} href="/images?tab=registries" target="_blank" rel="noreferrer">{t('setupRegistryInNewWindow')}</Button><Button size="small" type="link" loading={refreshingSources} onClick={() => void refreshImageSources()}>{t('refreshImageSources')}</Button></Space>} /> : selectedRegistry && <Alert type={selectedRegistry.status === 'online' ? 'success' : 'info'} showIcon message={t('registryMatchesImageSource', { host: imageRegistryHost(selected?.version.imageReference || '') })} description={selectedRegistry.statusMessage ? t(selectedRegistry.statusMessage) : t('registryWillBeVerifiedOnTarget')} />}</>}{imageSource === 'offline' && <><Form.Item name="imageArtifactId" label={t('offlineImage')} rules={[{ required: true }]}><Select placeholder={t('selectCompatibleImage')} options={compatibleImages.map((item) => ({ value: item.id, label: `${item.name} · ${bytes(item.sizeBytes)} · ${item.architectures.join(' / ')}` }))} /></Form.Item>{compatibleImages.length === 0 && <Alert type="warning" showIcon message={t('noCompatibleImages')} description={<Space direction="vertical" size={2}><span>{t('noCompatibleImagesHint', { image: selected ? templateImageReferences(selected.version).join(' · ') : '—' })}</span><span>{t('imageSourceSetupHint')}</span></Space>} action={<Space direction="vertical" size={4}><Button size="small" type="primary" icon={<ExportOutlined />} href="/images" target="_blank" rel="noreferrer">{t('setupImageInNewWindow')}</Button><Button size="small" type="link" loading={refreshingSources} onClick={() => void refreshImageSources()}>{t('refreshImageSources')}</Button></Space>} />}{selectedImage && capacityCandidates.length === 0 && <Alert type="warning" showIcon message={t('hostCapacityUnavailable')} description={t('hostCapacityUnavailableHint')} />}</>}<Form.Item name="autoRestart" label={t('autoRestart')} valuePropName="checked"><Switch /></Form.Item><Form.Item name="extraEnvironment" label={t('extraEnvironment')} rules={[{ validator: (_, value?: string) => { if (!value?.trim()) return Promise.resolve(); try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.values(parsed).every((item) => typeof item === 'string') ? Promise.resolve() : Promise.reject(new Error(t('invalidJSONObject'))) } catch { return Promise.reject(new Error(t('invalidJSONObject'))) } } }]}><Input.TextArea rows={5} placeholder={'{\n  "TZ": "Asia/Shanghai"\n}'} /></Form.Item></>}
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
        {selectedAuthentication !== 'password' && <Alert className="wizard-authentication-alert" type="warning" showIcon message={t('nonPasswordAuthenticationTitle')} description={t(`nonPasswordAuthenticationHint_${selectedAuthentication}`)} />}
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
              { key: 'authentication', label: t('authentication'), children: t(`authenticationMode_${selectedAuthentication}`) },
              { key: 'database', label: t('databaseName'), children: form.getFieldValue('databaseName') || '—' },
              ...(selectedAuthentication !== 'none' ? [{ key: 'username', label: t('username'), children: form.getFieldValue('username') || '—' }] : []),
              ...(selectedAuthentication === 'password' ? [{ key: 'password', label: t('password'), children: form.getFieldValue('password') ? t('customPasswordConfigured') : t('passwordGeneratedAfterCreate') }] : []),
              { key: 'image', label: t('imageSource'), children: imageSource === 'offline' ? images.find((item) => item.id === form.getFieldValue('imageArtifactId'))?.name || '—' : imageSource === 'registry' ? registries.find((registry) => registry.id === form.getFieldValue('registryId'))?.name || '—' : t('publicRegistry') },
            ]} />
          </Card>
        </div>
        <Card size="small" className="create-review-card create-review-options" title={t('deploymentOptions')}>
          <Descriptions column={{ xs: 1, sm: 2 }} colon={false} items={[
            { key: 'purpose', label: t('purpose'), span: 2, children: form.getFieldValue('purpose') || t('purposeMissing') },
            { key: 'owner', label: t('owner'), children: form.getFieldValue('owner') || t('ownerMissing') },
            { key: 'expiresAt', label: t('expectedExpiry'), children: form.getFieldValue('expiresAt') ? formatDateTime(form.getFieldValue('expiresAt').toISOString(), i18n.language, timezone) : t('retainIndefinitely') },
            { key: 'restart', label: t('autoRestart'), children: form.getFieldValue('autoRestart') ? t('enabled') : t('disabled') },
            { key: 'labels', label: t('labels'), children: form.getFieldValue('labels') || '—' },
            ...(selectedTemplateParameters.length ? [{ key: 'templateParameters', label: t('templateParameters'), span: 2, children: <Space wrap>{selectedTemplateParameters.map((parameter) => <Tag key={parameter.key}>{localizedTemplateText(parameter.label, parameter.labelZh, i18n.language)}: {displayTemplateParameterValue(parameter, submittedTemplateParameters?.[parameter.key], i18n.language, t('enabled'), t('disabled'))}</Tag>)}</Space> }] : []),
            { key: 'environmentVariables', label: t('extraEnvironment'), span: 2, children: <Typography.Text code>{form.getFieldValue('extraEnvironment') || '—'}</Typography.Text> },
          ]} />
        </Card>
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
            {!createFailure.existingInstanceId && createRecoveryStep < 4 && <Button size="small" type="primary" onClick={() => { setCreateFailure(undefined); setStep(createRecoveryStep) }}>{t(`reviewCreateStep_${createRecoveryStep}`)}</Button>}
            <Button size="small" icon={<ReloadOutlined />} loading={refreshingCreateContext} onClick={() => void refreshCreateContext()}>{t('refreshDeploymentContext')}</Button>
          </Space>}
        />}
      </div>}
    </Form></Drawer>
  </>
}

interface Metric { collectedAt: string; cpuPercent: number; memoryBytes: number; memoryPercent: number; diskUsedBytes: number; diskTotalBytes: number }
interface Connection { address: string; port: number; username: string; password: string; database: string; authentication: 'password' | 'username' | 'none'; uri: string; jdbc?: string }

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
  const lines = [
    `DB_HOST=${value(connection.address)}`,
    `DB_PORT=${connection.port}`,
  ]
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
  const [item, setItem] = useState<Instance | null>(null)
  const [pageLoading, setPageLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [connection, setConnection] = useState<Connection | null>(null)
  const [connectionLoading, setConnectionLoading] = useState(false)
  const [connectionError, setConnectionError] = useState('')
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const [logsUpdatedAt, setLogsUpdatedAt] = useState<Date>()
  const [logTail, setLogTail] = useState(1000)
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true)
  const [metrics, setMetrics] = useState<Metric[]>([])
  const [metricsLoading, setMetricsLoading] = useState(false)
  const [metricsError, setMetricsError] = useState('')
  const [metricHours, setMetricHours] = useState(24)
  const [templates, setTemplates] = useState<DatabaseTemplate[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [allInstances, setAllInstances] = useState<Instance[]>([])
  const [instanceInventoryReady, setInstanceInventoryReady] = useState(false)
  const [images, setImages] = useState<ImageArtifact[]>([])
  const [registries, setRegistries] = useState<Registry[]>([])
  const [backups, setBackups] = useState<InstanceBackup[]>([])
  const [backupInventoryState, setBackupInventoryState] = useState<CleanupEvidenceState>('loading')
  const [backupInventoryError, setBackupInventoryError] = useState('')
  const [backupPolicy, setBackupPolicy] = useState<InstanceBackupPolicy | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [taskInventoryState, setTaskInventoryState] = useState<CleanupEvidenceState>('loading')
  const [taskInventoryError, setTaskInventoryError] = useState('')
  const [cleanupRetryError, setCleanupRetryError] = useState('')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [upgradeVersion, setUpgradeVersion] = useState<string>()
  const [upgradeImageSource, setUpgradeImageSource] = useState<ImageSource>('public')
  const [upgradeImageArtifactID, setUpgradeImageArtifactID] = useState<string>()
  const [upgradeRegistryID, setUpgradeRegistryID] = useState<string>()
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  const [backupCreateOpen, setBackupCreateOpen] = useState(false)
  const [backupPolicyOpen, setBackupPolicyOpen] = useState(false)
  const [backupPolicySaving, setBackupPolicySaving] = useState(false)
  const [backupName, setBackupName] = useState('')
  const [backupAction, setBackupAction] = useState<{ type: 'restore' | 'delete'; backup: InstanceBackup }>()
  const [backupConfirm, setBackupConfirm] = useState('')
  const [backupRequestFailure, setBackupRequestFailure] = useState<{ action: BackupRequestAction; code: string; message: string; backupId?: string; backupName: string }>()
  const [editOpen, setEditOpen] = useState(false)
  const [editSaving, setEditSaving] = useState(false)
  const [actioning, setActioning] = useState('')
  const [taskCancellationFailure, setTaskCancellationFailure] = useState<{ taskId: string; message: string }>()
  const [lifecycleConfirmAction, setLifecycleConfirmAction] = useState<InstanceLifecycleAction>()
  const [lifecycleRequestFailure, setLifecycleRequestFailure] = useState<{ action: InstanceLifecycleAction; code: string; message: string }>()
  const [changeRequestFailure, setChangeRequestFailure] = useState<InstanceChangeRequestFailure>()
  const [activeTab, setActiveTab] = useState(['overview', 'connection', 'logs', 'metrics', 'backups'].includes(requestedTab || '') ? requestedTab! : 'overview')
  const taskRetry = useTaskRetryRequest()
  const [editForm] = Form.useForm<EditValues>()
  const [runtimeForm] = Form.useForm<RuntimeValues>()
  const [backupPolicyForm] = Form.useForm<BackupPolicyValues>()
  const backupPolicyEnabled = Form.useWatch('enabled', backupPolicyForm)
  const backupPolicyFrequency = Form.useWatch('frequency', backupPolicyForm)
  const runtimeCPU = Form.useWatch('cpu', runtimeForm)
  const runtimeMemoryGiB = Form.useWatch('memoryGiB', runtimeForm)
  const runtimeDiskGiB = Form.useWatch('diskGiB', runtimeForm)
  const runtimeEnvironmentText = Form.useWatch('extraEnvironment', runtimeForm)
  const runtimeAutoRestart = Form.useWatch('autoRestart', runtimeForm)
  const load = useCallback(async () => {
    try {
      const instance = await api<Instance>(`/instances/${id}`)
      setItem(instance)
      const [catalog, projectList, hostList, instanceList, imageList, registryList, backupList, policyResult, taskList] = await Promise.allSettled([
        api<{ items: DatabaseTemplate[] }>('/templates'),
        api<{ items: Project[] }>('/projects'),
        api<{ items: Host[] }>('/hosts'),
        api<{ items: Instance[] }>('/instances'),
        api<{ items: ImageArtifact[] }>('/images'),
        api<{ items: Registry[] }>('/registries'),
        api<{ items: InstanceBackup[] }>(`/instances/${id}/backups`),
        api<{ policy: InstanceBackupPolicy | null }>(`/instances/${id}/backup-policy`),
        api<{ items: Task[] }>(`/instances/${id}/tasks`),
      ])
      if (catalog.status === 'fulfilled') setTemplates(catalog.value.items)
      if (projectList.status === 'fulfilled') setProjects(projectList.value.items)
      if (hostList.status === 'fulfilled') setHosts(hostList.value.items)
      if (instanceList.status === 'fulfilled') { setAllInstances(instanceList.value.items); setInstanceInventoryReady(true) } else setInstanceInventoryReady(false)
      if (imageList.status === 'fulfilled') setImages(imageList.value.items)
      if (registryList.status === 'fulfilled') setRegistries(registryList.value.items)
      if (backupList.status === 'fulfilled') {
        setBackups(backupList.value.items)
        setBackupInventoryState('ready')
        setBackupInventoryError('')
      } else {
        setBackupInventoryState('error')
        setBackupInventoryError(errorMessage(backupList.reason))
      }
      if (policyResult.status === 'fulfilled') setBackupPolicy(policyResult.value.policy)
      if (taskList.status === 'fulfilled') {
        setTasks(taskList.value.items)
        setTaskInventoryState('ready')
        setTaskInventoryError('')
      } else {
        setTaskInventoryState('error')
        setTaskInventoryError(errorMessage(taskList.reason))
      }
      const failedRequest = [catalog, projectList, hostList, instanceList, imageList, registryList, backupList, policyResult, taskList].find((result) => result.status === 'rejected')
      setPageError(failedRequest?.status === 'rejected' ? errorMessage(failedRequest.reason) : '')
    } catch (error) { setPageError(errorMessage(error)) } finally { setPageLoading(false) }
  }, [id])
  const instanceTasks = tasks.filter((task) => task.resourceType === 'instance' && task.resourceId === id)
  const activeCleanupTask = tasks.find((task) => ['queued', 'running', 'retrying'].includes(task.status))
  const hasActiveTask = !!activeCleanupTask
  const hasActiveOperation = hasActiveTask || hasActiveBackupOperation(backups.map((backup) => backup.status))
  useEffect(() => {
    setItem(null)
    setPageLoading(true)
    setBackupInventoryState('loading')
    setBackupInventoryError('')
    setTaskInventoryState('loading')
    setTaskInventoryError('')
    setCleanupRetryError('')
    setLifecycleConfirmAction(undefined)
    setLifecycleRequestFailure(undefined)
    setChangeRequestFailure(undefined)
    setBackupRequestFailure(undefined)
    taskRetry.clear()
    void load()
  }, [load, taskRetry.clear])
  useEffect(() => { const timer = window.setInterval(() => void load(), hasActiveOperation ? 2000 : 10000); return () => clearInterval(timer) }, [hasActiveOperation, load])
  useEffect(() => { if (hasActiveOperation) setLifecycleRequestFailure(undefined) }, [hasActiveOperation])
  useEffect(() => { if (requestedTab && ['overview', 'connection', 'logs', 'metrics', 'backups'].includes(requestedTab)) setActiveTab(requestedTab) }, [requestedTab])
  const changeTab = (tab: string) => {
    const next = new URLSearchParams(detailParams)
    if (tab === 'overview') next.delete('tab')
    else next.set('tab', tab)
    if (tab !== 'backups') next.delete('cleanup')
    setActiveTab(tab)
    setDetailParams(next, { replace: true })
  }
  const run = async (action: string, body: Record<string, unknown> = {}) => {
    const lifecycleAction = isInstanceLifecycleAction(action) ? action : undefined
    const changeRequestAction = isInstanceChangeRequestAction(action) ? action : undefined
    let accepted = false
    try {
      setActioning(action)
      if (lifecycleAction) setLifecycleRequestFailure(undefined)
      if (changeRequestAction) setChangeRequestFailure(undefined)
      const task = await api<Task>(`/instances/${id}/actions/${action}`, { method: 'POST', body })
      setTasks((current) => [task, ...current])
      notifyTask(task)
      setUpgradeOpen(false)
      setRuntimeOpen(false)
      await load()
      accepted = true
    } catch (error) {
      if (lifecycleAction) {
        setLifecycleRequestFailure({
          action: lifecycleAction,
          code: error instanceof ApiError ? error.code : 'unknown',
          message: errorMessage(error),
        })
        await load()
      } else if (changeRequestAction) {
        setChangeRequestFailure({
          action: changeRequestAction,
          code: error instanceof ApiError ? error.code : 'unknown',
          message: errorMessage(error),
        })
        await load()
      } else {
        message.error(errorMessage(error))
      }
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
    if (await run(lifecycleConfirmAction)) setLifecycleConfirmAction(undefined)
  }
  const refreshLifecycleState = async () => {
    try {
      setActioning('refresh-lifecycle-state')
      await load()
    } finally {
      setActioning('')
    }
  }
  const refreshChangeRequestState = async () => {
    try {
      setActioning('refresh-change-request-state')
      await load()
    } finally {
      setActioning('')
    }
  }
  const createBackup = async () => {
    try {
      setActioning('backup-create')
      setBackupRequestFailure(undefined)
      const result = await api<{ backup: InstanceBackup; task: Task }>(`/instances/${id}/backups`, { method: 'POST', body: { name: backupName } })
      setBackups((current) => [result.backup, ...current.filter((backup) => backup.id !== result.backup.id)])
      setTasks((current) => [result.task, ...current])
      notifyTask(result.task)
      setBackupCreateOpen(false)
      setBackupName('')
      await load()
    } catch (error) {
      setBackupRequestFailure({
        action: 'create',
        code: error instanceof ApiError ? error.code : 'unknown',
        message: errorMessage(error),
        backupName,
      })
      await load()
    } finally { setActioning('') }
  }
  const submitBackupAction = async () => {
    if (!backupAction || !item) return
    const submittedAction = backupAction
    const expected = submittedAction.type === 'restore' ? item.name : submittedAction.backup.name
    if (backupConfirm !== expected) return
    const actionKey = `backup-${submittedAction.type}`
    try {
      setActioning(actionKey)
      setBackupRequestFailure(undefined)
      const result = await api<{ backup: InstanceBackup; task: Task }>(`/instances/${id}/backups/${submittedAction.backup.id}/${submittedAction.type}`, { method: 'POST', body: { confirmName: backupConfirm } })
      setBackups((current) => current.map((backup) => backup.id === result.backup.id ? result.backup : backup))
      setTasks((current) => [result.task, ...current])
      notifyTask(result.task)
      setBackupAction(undefined)
      setBackupConfirm('')
      await load()
    } catch (error) {
      setBackupRequestFailure({
        action: submittedAction.type,
        code: error instanceof ApiError ? error.code : 'unknown',
        message: errorMessage(error),
        backupId: submittedAction.backup.id,
        backupName: submittedAction.backup.name,
      })
      setBackupConfirm('')
      await load()
    } finally { setActioning('') }
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
  const showConnectionHandoff = () => { changeTab('connection'); void loadConnection() }
  const loadLogs = useCallback(async () => { try { setLogsLoading(true); setLogsError(''); const response = await fetch(`/api/v1/instances/${id}/logs?tail=${logTail}`, { credentials: 'same-origin' }); const text = await response.text(); if (!response.ok) throw responseError(text, response.status); setLogs(text); setLogsUpdatedAt(new Date()) } catch (error) { setLogsError(errorMessage(error)) } finally { setLogsLoading(false) } }, [id, logTail])
  const loadMetrics = useCallback(async () => { try { setMetricsLoading(true); setMetricsError(''); const response = await api<{ items: Metric[] }>(`/instances/${id}/metrics?hours=${metricHours}`); setMetrics(response.items) } catch (error) { setMetricsError(errorMessage(error)) } finally { setMetricsLoading(false) } }, [id, metricHours])
  useEffect(() => { if (activeTab !== 'logs' && activeTab !== 'metrics') return; const refresh = () => activeTab === 'logs' ? loadLogs() : loadMetrics(); void refresh(); if (activeTab === 'logs' && !logsAutoRefresh) return; const timer = window.setInterval(() => void refresh(), activeTab === 'logs' ? 5000 : 30000); return () => clearInterval(timer) }, [activeTab, loadLogs, loadMetrics, logsAutoRefresh])
  useEffect(() => {
    if (activeTab !== 'connection') {
      setConnection(null)
      setConnectionError('')
    }
  }, [activeTab])
  const showEdit = () => { if (!item) return; editForm.resetFields(); editForm.setFieldsValue({ name: item.name, projectId: item.projectId, environment: item.environment, purpose: item.purpose, owner: item.owner || user?.displayName || user?.username || '', expiresAt: item.expiresAt ? dayjs(item.expiresAt) : undefined, labels: Object.entries(item.labels || {}).map(([key, value]) => `${key}=${value}`).join(', ') }); setEditOpen(true) }
  const showUpgrade = () => {
    if (changeRequestFailure?.action !== 'upgrade') {
      setChangeRequestFailure(undefined)
      setUpgradeVersion(undefined)
      setUpgradeImageSource('public')
      setUpgradeImageArtifactID(undefined)
      setUpgradeRegistryID(undefined)
    }
    setUpgradeOpen(true)
  }
  const showRuntimeConfiguration = () => {
    if (!item) return
    if (changeRequestFailure?.action !== 'reconfigure') {
      setChangeRequestFailure(undefined)
      runtimeForm.setFieldsValue({
        cpu: item.cpu,
        memoryGiB: item.memoryBytes / 1024 ** 3,
        diskGiB: item.reservedDiskBytes / 1024 ** 3,
        extraEnvironment: JSON.stringify(item.configuration?.extraEnvironment || {}, null, 2),
        autoRestart: item.autoRestart,
      })
    }
    setRuntimeOpen(true)
  }
  const showBackupPolicy = () => {
    backupPolicyForm.setFieldsValue({
      enabled: backupPolicy?.enabled ?? true,
      frequency: backupPolicy?.frequency ?? 'daily',
      weekday: backupPolicy?.weekday ?? 0,
      hour: backupPolicy?.hour ?? 2,
      minute: backupPolicy?.minute ?? 0,
      timezone: backupPolicy?.timezone || timezone,
      retentionCount: backupPolicy?.retentionCount ?? 7,
    })
    setBackupPolicyOpen(true)
  }
  const saveBackupPolicy = async () => {
    try {
      const values = await backupPolicyForm.validateFields()
      setBackupPolicySaving(true)
      const result = await api<{ policy: InstanceBackupPolicy }>(`/instances/${id}/backup-policy`, {
        method: 'PUT', body: { ...values, weekday: values.frequency === 'weekly' ? values.weekday : 0 },
      })
      setBackupPolicy(result.policy)
      setBackupPolicyOpen(false)
      message.success(t('backupPolicySaved'))
      await load()
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally { setBackupPolicySaving(false) }
  }
  const saveEdit = async () => { try { setEditSaving(true); const values = await editForm.validateFields(); const labels = parseLabelText(values.labels) || {}; await api(`/instances/${id}`, { method: 'PATCH', body: { name: values.name, projectId: values.projectId || null, environment: values.environment, purpose: values.purpose?.trim() || '', owner: values.owner.trim(), expiresAt: values.expiresAt?.toISOString() || null, labels } }); message.success(t('saved')); setEditOpen(false); await load() } catch (error) { if (error instanceof Error) message.error(errorMessage(error)) } finally { setEditSaving(false) } }
  if (!item) return <Card loading={pageLoading}><EmptyState compact action={() => { setPageLoading(true); void load() }} actionLabel={t('retry')} description={pageError || t('instanceLoadFailed')} /></Card>
  const instanceHost = hosts.find((host) => host.id === item.hostId)
  const currentTemplate = templates.find((tpl) => tpl.slug === item.templateSlug)
  const currentVersion = currentTemplate?.versions.find((version) => version.id === item.templateVersionId)
  const runtimeHostReservation = reservationForHost(allInstances.filter((candidate) => candidate.id !== item.id), item.hostId)
  const runtimeTarget = { cpu: runtimeCPU || 0, memory: Math.round((runtimeMemoryGiB || 0) * 1024 ** 3), disk: Math.round((runtimeDiskGiB || 0) * 1024 ** 3) }
  const runtimeEnvironment = parseStringMap(runtimeEnvironmentText)
  const runtimeMinimumReady = !!currentVersion && runtimeTarget.cpu >= currentVersion.minCpu && runtimeTarget.memory >= currentVersion.minMemoryBytes && runtimeTarget.disk >= currentVersion.minDiskBytes
  const runtimeCapacityReady = instanceInventoryReady && !!instanceHost && instanceHost.status === 'online' && !instanceHost.maintenance &&
    hostCanReconfigure(instanceHost, runtimeHostReservation,
      { cpu: item.cpu, memory: item.memoryBytes, disk: item.reservedDiskBytes }, runtimeTarget)
  const runtimeRemaining = instanceHost && runtimeCapacityReady ? remainingAfterDeployment(instanceHost, runtimeHostReservation, runtimeTarget) : undefined
  const runtimeChanged = runtimeTarget.cpu !== item.cpu || runtimeTarget.memory !== item.memoryBytes || runtimeTarget.disk !== item.reservedDiskBytes ||
    (runtimeAutoRestart ?? item.autoRestart) !== item.autoRestart ||
    (!!runtimeEnvironment && !sameStringMap(runtimeEnvironment, item.configuration?.extraEnvironment || {}))
  const runtimeReady = runtimeMinimumReady && runtimeCapacityReady && !!runtimeEnvironment && runtimeChanged
  const upgradeVersions = currentTemplate?.versions.filter((version) => version.selectable !== false && version.id !== item.templateVersionId &&
    (!instanceHost?.architecture || version.architectures.includes(instanceHost.architecture))) ?? []
  const upgradeOptions = upgradeVersions.map((version) => ({ value: version.id, label: version.version }))
  const upgradeTarget = upgradeVersions.find((version) => version.id === upgradeVersion)
  const upgradeCompatibleImages = images.filter((image) => image.status === 'ready' && !!upgradeTarget &&
    imageArtifactMatchesTemplate(image.imageRefs, upgradeTarget) && (!instanceHost?.architecture || image.architectures.includes(instanceHost.architecture)))
  const upgradeCompatibleRegistries = registries.filter((registry) => !!upgradeTarget && registryMatchesTemplate(registry.url, upgradeTarget))
  const upgradeRegistry = upgradeCompatibleRegistries.find((registry) => registry.id === upgradeRegistryID)
  const upgradeReady = !!upgradeTarget && (upgradeImageSource === 'public' ||
    (upgradeImageSource === 'offline' && !!upgradeImageArtifactID) || (upgradeImageSource === 'registry' && !!upgradeRegistryID))
  const submitUpgrade = () => {
    if (!upgradeReady || !upgradeVersion) return
    void run('upgrade', {
      templateVersionId: upgradeVersion,
      imageSource: upgradeImageSource,
      imageArtifactId: upgradeImageSource === 'offline' ? upgradeImageArtifactID : null,
      registryId: upgradeImageSource === 'registry' ? upgradeRegistryID : null,
    })
  }
  const submitRuntimeConfiguration = async () => {
    try {
      const values = await runtimeForm.validateFields()
      const extraEnvironment = parseStringMap(values.extraEnvironment)
      if (!runtimeReady || !extraEnvironment) return
      await run('reconfigure', {
        cpu: values.cpu,
        memoryBytes: Math.round(values.memoryGiB * 1024 ** 3),
        diskBytes: Math.round(values.diskGiB * 1024 ** 3),
        extraEnvironment,
        autoRestart: values.autoRestart,
      })
    } catch { /* form marks errors */ }
  }
  const project = projects.find((candidate) => candidate.id === item.projectId)
  const { activeTask, failedTask, operationTask } = selectRecoveryTasks(instanceTasks, isRecoverableInstanceStatus(item.status))
  const mostRecentRestoreTask = latestRestoreTask(instanceTasks)
  const latestRestoreOutcome = restoreOutcome(mostRecentRestoreTask, item)
  const latestRestoreVerification = restoreVerification(mostRecentRestoreTask, backups, item)
  const restoreOutcomeTask = latestRestoreOutcome ? mostRecentRestoreTask : undefined
  const deploymentHandoff = selectDeploymentHandoff(instanceTasks, item.status)
  const failedGuidance = failedTask ? taskFailureGuidance(failedTask) : undefined
  const failedHostRecoveryPath = failedTask && failedGuidance?.inspectHost ? taskHostRecoveryPath(item.hostId, failedTask.id) : undefined
  const lifecycleRequestCanRetry = lifecycleRequestFailure && !operationTask &&
    canRetryInstanceLifecycleAction(lifecycleRequestFailure.action, item.status, lifecycleRequestFailure.code)
  const changeRequestEvidenceReady = !pageError && instanceInventoryReady && taskInventoryState === 'ready' &&
    !!instanceHost && !!currentVersion
  const changeRequestCanRetry = !!changeRequestFailure && canOperate && changeRequestEvidenceReady &&
    canRetryInstanceChangeRequest(changeRequestFailure.action, item.status, changeRequestFailure.code, !!operationTask)
  const changeRequestActionLabel = changeRequestFailure
    ? t(changeRequestFailure.action === 'reconfigure' ? 'runtimeConfiguration' : 'upgrade')
    : ''
  const changeRequestFailureDetails = changeRequestFailure && <div className="instance-action-request-description">
    <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{changeRequestFailure.message}</Typography.Text></div>
    <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t(instanceChangeRequestImpactKey(changeRequestFailure.action))}</Typography.Text></div>
    <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(instanceChangeRequestRecoveryKey(changeRequestFailure.code))}</Typography.Text></div>
    {operationTask && <div><Typography.Text type="secondary">{t('currentTask')}</Typography.Text><Typography.Text>{t('instanceChangeRequestActiveTaskHint', { task: translateCode(t, operationTask.kind, 'taskKind'), status: translateCode(t, operationTask.status) })}</Typography.Text></div>}
  </div>
  const closeChangeRequestModal = () => {
    setUpgradeOpen(false)
    setRuntimeOpen(false)
  }
  const inspectChangeRequestLogs = () => {
    closeChangeRequestModal()
    changeTab('logs')
  }
  const openChangeRequestDraft = () => {
    if (!changeRequestFailure) return
    if (changeRequestFailure.action === 'reconfigure') showRuntimeConfiguration()
    else showUpgrade()
  }
  const changeRequestFailureActions = changeRequestFailure && <Space wrap className="instance-action-request-actions">
    <Button size="small" icon={<ReloadOutlined />} loading={actioning === 'refresh-change-request-state'} disabled={!!actioning && actioning !== 'refresh-change-request-state'} onClick={() => void refreshChangeRequestState()}>{t('refreshStatus')}</Button>
    {operationTask && <Button size="small" onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewCurrentTask')}</Button>}
    <Button size="small" onClick={inspectChangeRequestLogs}>{t('viewInstanceLogs')}</Button>
    {changeRequestFailure.code === 'not_found' && <Button size="small" onClick={() => navigate('/instances')}>{t('backToInstances')}</Button>}
    {changeRequestCanRetry && <Button size="small" type="primary" disabled={!!actioning} onClick={openChangeRequestDraft}>{t('reviewInstanceChange', { action: changeRequestActionLabel })}</Button>}
    <Button size="small" type="text" onClick={() => setChangeRequestFailure(undefined)}>{t('dismiss')}</Button>
  </Space>
  const changeRequestFailurePanel = changeRequestFailure && !runtimeOpen && !upgradeOpen && <Alert
    className="instance-page-alert instance-action-request-alert"
    type="error"
    showIcon
    message={t('instanceChangeRequestFailed', { action: changeRequestActionLabel })}
    description={changeRequestFailureDetails}
    action={changeRequestFailureActions}
  />
  const changeRequestModalFailure = changeRequestFailure && <Alert
    className="instance-change-request-alert"
    type="error"
    showIcon
    message={t('instanceChangeRequestFailed', { action: changeRequestActionLabel })}
    description={<div className="instance-change-request-modal-description">
      {changeRequestFailureDetails}
      <Space wrap className="instance-action-request-actions">
        <Button size="small" icon={<ReloadOutlined />} loading={actioning === 'refresh-change-request-state'} disabled={!!actioning && actioning !== 'refresh-change-request-state'} onClick={() => void refreshChangeRequestState()}>{t('refreshStatus')}</Button>
        {operationTask && <Button size="small" onClick={() => navigate(`/tasks?task=${operationTask.id}`)}>{t('viewCurrentTask')}</Button>}
        <Button size="small" onClick={inspectChangeRequestLogs}>{t('viewInstanceLogs')}</Button>
        {changeRequestFailure.code === 'not_found' && <Button size="small" onClick={() => navigate('/instances')}>{t('backToInstances')}</Button>}
      </Space>
    </div>}
  />
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
    } finally { setActioning('') }
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
  const retryBackupDelete = async (task: Task) => {
    const actionKey = `retry-backup-delete:${task.id}`
    try {
      setActioning(actionKey)
      setCleanupRetryError('')
      const retried = await api<Task>(`/tasks/${task.id}/retry`, { method: 'POST', body: {} })
      setTasks((current) => [retried, ...current])
      notifyTask(retried)
      await load()
    } catch (error) {
      setCleanupRetryError(errorMessage(error))
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
  const operationPanel = operationTask && (!latestRestoreOutcome || activeTask || operationTask.id !== restoreOutcomeTask?.id) && <div className={`instance-operation is-${activeTask ? 'active' : 'failed'}`}>
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
      {canOperate && canReviewIncompleteDeploymentCleanup(operationTask) && <Button icon={<SafetyCertificateOutlined />} disabled={!!actioning} onClick={() => setCleanupOpen(true)}>{t('reviewCleanup')}</Button>}
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
  const restoreOutcomePanel = latestRestoreOutcome && restoreOutcomeTask && !activeTask && <Alert
    className="restore-outcome-alert"
    type={latestRestoreOutcome.state === 'pre_restore_recovered' ? 'warning' : 'error'}
    showIcon
    message={t(`restoreOutcomeTitle_${latestRestoreOutcome.state}`)}
    description={<div className="restore-outcome-body">
      <Typography.Text>{t(`restoreOutcomeDescription_${latestRestoreOutcome.state}`)}</Typography.Text>
      <div className="restore-outcome-facts">
        <div><Typography.Text type="secondary">{t('restoreOutcomeTarget')}</Typography.Text><Typography.Text strong>{t(`restoreOutcomeTarget_${latestRestoreOutcome.state}`)}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('restoreOutcomeData')}</Typography.Text><Typography.Text strong>{t(`restoreOutcomeData_${latestRestoreOutcome.state}`)}</Typography.Text></div>
        <div><Typography.Text type="secondary">{t('restoreOutcomeHandoff')}</Typography.Text><Typography.Text strong>{t(latestRestoreOutcome.state === 'rollback_incomplete' ? 'restoreOutcomeHandoff_blocked' : latestRestoreOutcome.instanceStatus === 'running' ? 'restoreOutcomeHandoff_running' : latestRestoreOutcome.instanceStatus === 'stopped' ? 'restoreOutcomeHandoff_stopped' : 'restoreOutcomeHandoff_review')}</Typography.Text></div>
      </div>
      <Space wrap className="restore-outcome-actions">
        {canOperate && taskRetry.failure?.taskId !== restoreOutcomeTask.id && <Button size="small" type={latestRestoreOutcome.state === 'pre_restore_recovered' ? 'primary' : 'default'} icon={<ReloadOutlined />} loading={taskRetry.submittingTaskID === restoreOutcomeTask.id} disabled={Boolean(actioning && actioning !== 'retry-task')} onClick={() => void retryTask(restoreOutcomeTask)}>{t('retryRestore')}</Button>}
        <Button size="small" type={latestRestoreOutcome.state === 'rollback_incomplete' ? 'primary' : 'default'} onClick={() => navigate(`/tasks?task=${restoreOutcomeTask.id}`)}>{t('viewTask')}</Button>
        <Button size="small" onClick={() => changeTab('logs')}>{t('viewInstanceLogs')}</Button>
      </Space>
    </div>}
  />
  const restoreVerificationPanel = latestRestoreVerification && !operationTask && activeTab === 'overview' && <Alert
    className="restore-verification-alert"
    type={item.status === 'running' ? 'success' : 'warning'}
    showIcon
    message={t('restoreVerificationTitle')}
    description={<div className="restore-verification-body">
      <Typography.Text>{t(item.status === 'running' ? 'restoreVerificationDescription_running' : item.status === 'stopped' ? 'restoreVerificationDescription_stopped' : 'restoreVerificationDescription_unavailable', { status: translateCode(t, item.status) })}</Typography.Text>
      {!canReadCredentials && <Typography.Text type="secondary">{t('restoreVerificationRestricted')}</Typography.Text>}
      <RestoreVerificationFacts verification={latestRestoreVerification} />
      <Space wrap className="restore-verification-actions">
        {canReadCredentials && item.status === 'running' && <Button type="primary" size="small" icon={<CopyOutlined />} loading={connectionLoading} onClick={showConnectionHandoff}>{t('showConnectionHandoff')}</Button>}
        <Button size="small" onClick={() => navigate(`/tasks?task=${latestRestoreVerification.task.id}`)}>{t('viewRestoreTask')}</Button>
        <Button size="small" onClick={() => changeTab('backups')}>{t('viewRestoredBackup')}</Button>
      </Space>
    </div>}
  />
  const deploymentReadyPanel = !operationTask && !latestRestoreOutcome && !latestRestoreVerification && activeTab === 'overview' && deploymentHandoff?.state === 'ready' && <div className="instance-operation is-ready">
    <div className="instance-operation-copy">
      <Space wrap><StatusTag value={deploymentHandoff.task.status} /><Typography.Text strong>{t('deploymentReadyTitle')}</Typography.Text></Space>
      <Typography.Paragraph type="secondary">{t(canReadCredentials ? 'deploymentReadyHint' : 'deploymentReadyRestrictedHint')}</Typography.Paragraph>
    </div>
    <Space wrap className="instance-operation-actions">
      {canReadCredentials && <Button type="primary" icon={<CopyOutlined />} loading={connectionLoading} onClick={showConnectionHandoff}>{t('showConnectionHandoff')}</Button>}
      <Button onClick={() => navigate(`/tasks?task=${deploymentHandoff.task.id}`)}>{t('viewDeploymentTask')}</Button>
    </Space>
  </div>
  const healthDescription = item.statusMessage ? translateCode(t, item.statusMessage, 'statusMessage') : item.status === 'running' ? t('noHealthIssue') : item.status === 'stopped' ? t('healthStopped') : item.status === 'provisioning' ? t('healthProvisioning') : item.status === 'reconfiguring' ? t('healthReconfiguring') : item.status === 'degraded' ? t('healthDegraded') : t('healthUnavailable')
  const healthIcon = item.status === 'running' ? <CheckCircleOutlined /> : item.status === 'degraded' || item.status === 'provisioning' || item.status === 'reconfiguring' ? <WarningOutlined /> : item.status === 'failed' ? <CloseCircleOutlined /> : <PauseCircleOutlined />
  const healthTone = item.status === 'running' ? 'success' : item.status === 'degraded' || item.status === 'provisioning' || item.status === 'reconfiguring' ? 'warning' : item.status === 'failed' ? 'error' : 'neutral'
  const overview = <Row gutter={[16, 16]}><Col xs={24} xl={16}><Card title={t('runtime')}><Descriptions column={{ xs: 1, md: 2 }} items={[{ key: 'status', label: t('status'), children: <StatusTag value={item.status} /> },{ key: 'desired', label: t('desiredState'), children: translateCode(t, item.desiredState) },{ key: 'template', label: t('template'), children: `${item.templateName} ${item.templateVersion}` },{ key: 'host', label: t('host'), children: <Button type="link" className="description-link" onClick={() => navigate(`/hosts?host=${item.hostId}`)}>{item.hostName}</Button> },{ key: 'resource', label: t('resources'), children: `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },{ key: 'port', label: t('port'), children: `${item.bindAddress}:${item.hostPort} → ${item.containerPort}` },{ key: 'env', label: t('environment'), children: <Tag>{translateCode(t, item.environment)}</Tag> },{ key: 'restart', label: t('autoRestart'), children: item.autoRestart ? t('enabled') : t('disabled') },{ key: 'project', label: t('project'), children: project?.name || t('noProject') },{ key: 'created', label: t('createdAt'), children: formatDateTime(item.createdAt, i18n.language, timezone) },{ key: 'purpose', label: t('purpose'), span: 2, children: item.purpose || t('purposeMissing') },{ key: 'owner', label: t('owner'), children: item.owner || t('ownerMissing') },{ key: 'expiry', label: t('expectedExpiry'), children: <Space wrap><InstanceLifecycleTag expiresAt={item.expiresAt} />{item.expiresAt && <Typography.Text>{formatDateTime(item.expiresAt, i18n.language, timezone)}</Typography.Text>}</Space> },{ key: 'labels', label: t('labels'), span: 2, children: Object.keys(item.labels || {}).length ? <Space wrap>{Object.entries(item.labels).map(([key, value]) => <Tag key={key}>{key}={value}</Tag>)}</Space> : '—' }]} /></Card></Col><Col xs={24} xl={8}><Card title={t('health')} className="health-summary-card"><div className={`health-summary-icon is-${healthTone}`}>{healthIcon}</div><div className="health-summary-copy"><Space><StatusTag value={item.status} /><Typography.Text strong>{t('currentRuntimeState')}</Typography.Text></Space><Typography.Paragraph type="secondary">{healthDescription}</Typography.Paragraph></div><div className="health-facts"><div><Typography.Text type="secondary">{t('lastHealthy')}</Typography.Text><Typography.Text>{item.lastHealthyAt ? formatDateTime(item.lastHealthyAt, i18n.language, timezone) : t('notReported')}</Typography.Text></div><div><Typography.Text type="secondary">{t('restartFailures')}</Typography.Text><Typography.Text>{item.restartFailures}</Typography.Text></div></div></Card></Col></Row>
  const connectionErrorPanel = connectionError && <Alert
    className="connection-error-alert"
    type="error"
    showIcon
    message={t('connectionLoadFailed')}
    description={<div className="connection-error-description"><span>{connectionError}</span><span className="connection-error-hint">{t(connection ? 'connectionRefreshFailedHint' : 'connectionLoadFailedHint')}</span></div>}
    action={<Button size="small" loading={connectionLoading} onClick={() => void loadConnection()}>{t('retry')}</Button>}
  />
  const hideConnection = () => {
    setConnection(null)
    setConnectionError('')
  }
  const restoreConnectionContext = latestRestoreVerification && <Alert
    className="restore-connection-context"
    type={item.status === 'running' ? 'success' : 'warning'}
    showIcon
    message={t('restoreConnectionContextTitle', { name: latestRestoreVerification.backupName || latestRestoreVerification.backupId.slice(0, 8) })}
    description={<div className="restore-verification-body"><Typography.Text>{t('restoreConnectionContextDescription')}</Typography.Text><RestoreVerificationFacts verification={latestRestoreVerification} /></div>}
  />
  const connectionAuthentication = connection?.authentication || 'password'
  const connectionTab = <Card title={t('connectionCredentials')} className="connection-card">
    <Descriptions
      className="connection-handoff-context"
      title={t('connectionHandoffContextTitle')}
      size="small"
      bordered
      column={{ xs: 1, md: 2 }}
      items={[
        { key: 'project', label: t('project'), children: project?.name || t('noProject') },
        { key: 'environment', label: t('environment'), children: translateCode(t, item.environment) },
        { key: 'purpose', label: t('purpose'), span: 2, children: item.purpose || t('purposeMissing') },
        { key: 'owner', label: t('owner'), children: item.owner || t('ownerMissing') },
        { key: 'expiry', label: t('expectedExpiry'), children: item.expiresAt ? formatDateTime(item.expiresAt, i18n.language, timezone) : t('retainIndefinitely') },
      ]}
    />
    {restoreConnectionContext}
    {item.status !== 'running' && <Alert className="connection-status-alert" type="warning" showIcon message={t('connectionAvailabilityAffected')} description={t('connectionAvailabilityAffectedHint', { status: translateCode(t, item.status) })} />}
    {!canReadCredentials
      ? <div className="connection-gate"><div className="connection-gate-icon"><LockOutlined /></div><Typography.Title level={4}>{t('connectionRoleRestricted')}</Typography.Title><Typography.Paragraph type="secondary">{t('connectionRoleRestrictedHint')}</Typography.Paragraph></div>
      : !connection
        ? <div className="connection-gate"><div className="connection-gate-icon"><LockOutlined /></div><Typography.Title level={4}>{t('connectionProtectedTitle')}</Typography.Title><Typography.Paragraph type="secondary">{t('connectionProtectedDescription')}</Typography.Paragraph>{connectionErrorPanel || <Button type="primary" loading={connectionLoading} onClick={() => void loadConnection()}>{t('showConnectionDetails')}</Button>}</div>
        : <>
            {connectionErrorPanel}
            {connectionAuthentication !== 'password' && <Alert className="connection-authentication-alert" type="warning" showIcon message={t('nonPasswordAuthenticationTitle')} description={t(`nonPasswordAuthenticationHint_${connectionAuthentication}`)} />}
            <div className="connection-toolbar"><div><Typography.Text strong>{t('connectionReady')}</Typography.Text><Typography.Paragraph type="secondary">{t('connectionAuditNotice')}</Typography.Paragraph></div><Space wrap className="connection-actions"><Button type="primary" icon={<CopyOutlined />} onClick={() => void copyText(connectionHandoffText(item, project?.name, connection, latestRestoreVerification, t, i18n.language, timezone)).then(() => message.success(t('connectionHandoffCopied'))).catch((error) => message.error(errorMessage(error)))}>{t('copyConnectionHandoff')}</Button><Button icon={<CopyOutlined />} onClick={() => void copyText(environmentFile(connection)).then(() => message.success(t('environmentCopied'))).catch((error) => message.error(errorMessage(error)))}>{t('copyEnvironment')}</Button><Button icon={<EyeInvisibleOutlined />} onClick={hideConnection}>{t('hideConnectionDetails')}</Button><Button icon={<ReloadOutlined />} loading={connectionLoading} onClick={() => void loadConnection()}>{t('refresh')}</Button></Space></div>
            <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} items={[{ key: 'authentication', label: t('authentication'), children: t(`authenticationMode_${connectionAuthentication}`) },{ key: 'address', label: t('address'), children: <Typography.Text copyable={{ text: connection.address, icon: <CopyOutlined /> }}>{connection.address}</Typography.Text> },{ key: 'port', label: t('port'), children: <Typography.Text copyable={{ text: String(connection.port), icon: <CopyOutlined /> }}>{connection.port}</Typography.Text> },...(connection.username ? [{ key: 'username', label: t('username'), children: <Typography.Text copyable={{ text: connection.username, icon: <CopyOutlined /> }}>{connection.username}</Typography.Text> }] : []),...(connectionAuthentication === 'password' && connection.password ? [{ key: 'password', label: t('password'), children: <Typography.Text code copyable={{ text: connection.password, icon: <CopyOutlined /> }}>{connection.password}</Typography.Text> }] : []),...(connection.database ? [{ key: 'database', label: t('database'), children: <Typography.Text copyable={{ text: connection.database, icon: <CopyOutlined /> }}>{connection.database}</Typography.Text> }] : [])]} />
            <div className="connection-strings"><div className="connection-string"><Typography.Text type="secondary">{t('uri')}</Typography.Text><Typography.Text code copyable={{ text: connection.uri, icon: <CopyOutlined /> }}>{connection.uri}</Typography.Text></div>{connection.jdbc && <div className="connection-string"><Typography.Text type="secondary">{t('jdbc')}</Typography.Text><Typography.Text code copyable={{ text: connection.jdbc, icon: <CopyOutlined /> }}>{connection.jdbc}</Typography.Text></div>}</div>
          </>}
  </Card>
  const logsTab = <Card className="ops-panel" loading={logsLoading && !logs && !logsError} extra={<Space wrap><Select aria-label={t('logLines')} value={logTail} onChange={setLogTail} options={[100, 500, 1000, 5000].map((value) => ({ value, label: t('logLineCount', { count: value }) }))} /><Space size={6}><Switch size="small" checked={logsAutoRefresh} onChange={setLogsAutoRefresh} /><Typography.Text type="secondary">{t('autoRefresh')}</Typography.Text></Space><Button icon={<ReloadOutlined />} loading={logsLoading} onClick={() => void loadLogs()}>{t('refresh')}</Button><Button href={`/api/v1/instances/${id}/logs?tail=${logTail}&download=true`}>{t('download')}</Button></Space>} title={<Space>{t('logs')}{logsUpdatedAt && <Typography.Text type="secondary" className="logs-updated">{t('lastRefreshedAt', { time: formatTime(logsUpdatedAt, i18n.language, timezone) })}</Typography.Text>}</Space>}>{logsError && <Alert className="ops-alert" type="error" showIcon message={t('logsLoadFailed')} description={logsError} action={<Button size="small" onClick={() => void loadLogs()}>{t('retry')}</Button>} />}{logs ? <pre className="log-viewer">{logs}</pre> : !logsError && <EmptyState compact description={t('logsEmptyDescription')} />}</Card>
  const metricData = metrics.map((metric) => ({
    ...metric,
    diskPercent: metric.diskTotalBytes > 0 ? metric.diskUsedBytes * 100 / metric.diskTotalBytes : null,
    time: formatCompactDateTime(metric.collectedAt, i18n.language, timezone),
  }))
  const latestMetric = metrics.at(-1)
  const metricsTab = <Card className="ops-panel" loading={metricsLoading && !metrics.length && !metricsError} title={t('metrics')} extra={<Space><Select aria-label={t('metricWindow')} value={metricHours} onChange={setMetricHours} options={[{ value: 1, label: t('lastHour') },{ value: 6, label: t('last6Hours') },{ value: 24, label: t('last24Hours') },{ value: 168, label: t('last7Days') }]} /><Button icon={<ReloadOutlined />} loading={metricsLoading} onClick={() => void loadMetrics()}>{t('refresh')}</Button></Space>}>{metricsError && <Alert className="ops-alert" type="error" showIcon message={t('metricsLoadFailed')} description={metricsError} action={<Button size="small" onClick={() => void loadMetrics()}>{t('retry')}</Button>} />}{latestMetric && <div className="metric-summary"><div className="metric-stat"><Typography.Text type="secondary">{t('cpu')}</Typography.Text><strong>{latestMetric.cpuPercent.toFixed(1)}%</strong></div><div className="metric-stat"><Typography.Text type="secondary">{t('memoryUsage')}</Typography.Text><strong>{latestMetric.memoryPercent.toFixed(1)}%</strong><span>{bytes(latestMetric.memoryBytes)}</span></div><div className="metric-stat"><Typography.Text type="secondary">{t('hostDiskUsage')}</Typography.Text><strong>{latestMetric.diskTotalBytes > 0 ? `${(latestMetric.diskUsedBytes * 100 / latestMetric.diskTotalBytes).toFixed(1)}%` : t('notReported')}</strong>{latestMetric.diskTotalBytes > 0 && <span>{bytes(latestMetric.diskUsedBytes)} / {bytes(latestMetric.diskTotalBytes)}</span>}</div><div className="metric-stat"><Typography.Text type="secondary">{t('lastCollected')}</Typography.Text><strong className="metric-time">{formatDateTime(latestMetric.collectedAt, i18n.language, timezone)}</strong></div></div>}{metrics.length ? <div className="metric-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={metricData} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}><CartesianGrid stroke="#e8edf4" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="time" minTickGap={48} tick={{ fill: '#667085', fontSize: 12 }} axisLine={{ stroke: '#dfe5ec' }} tickLine={false} /><YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tick={{ fill: '#667085', fontSize: 12 }} axisLine={false} tickLine={false} /><ChartTooltip /><Legend /><Line type="monotone" dataKey="cpuPercent" name={t('cpuPercent')} stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line type="monotone" dataKey="memoryPercent" name={t('memoryPercent')} stroke="#0f9f8f" strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line type="monotone" dataKey="diskPercent" name={t('hostDiskPercent')} stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls /></LineChart></ResponsiveContainer></div> : !metricsError && <EmptyState compact description={t('metricsEmptyDescription')} />}</Card>
  const canStart = item.status === 'stopped' || (item.status === 'failed' && !failedTask && !activeTask)
  const canStopOrRestart = !operationTask && (item.status === 'running' || item.status === 'degraded')
  const lifecycleConfirmationAllowed = lifecycleConfirmAction === 'start' ? canStart
    : lifecycleConfirmAction === 'stop' || lifecycleConfirmAction === 'restart' ? canStopOrRestart
      : false
  const lifecycleConfirmationCanSubmit = lifecycleConfirmationAllowed &&
    (!lifecycleRequestFailure || lifecycleRequestFailure.action !== lifecycleConfirmAction || lifecycleRequestCanRetry)
  const canUpgrade = !operationTask && ['running', 'stopped', 'degraded'].includes(item.status)
  const canReconfigure = !operationTask && ['running', 'stopped', 'degraded'].includes(item.status)
  const canCreateBackup = !operationTask && ['running', 'stopped'].includes(item.status)
  const canRestoreBackup = (backup: InstanceBackup) => canRetryBackupRequest({
    action: 'restore',
    instanceStatus: item.status,
    hasActiveOperation,
    backupStatus: backup.status,
    sameTemplateVersion: backup.templateVersionId === item.templateVersionId,
  })
  const backupRequestBackup = backupRequestFailure?.backupId
    ? backups.find((backup) => backup.id === backupRequestFailure.backupId)
    : undefined
  const backupRequestEvidenceReady = !pageError && backupInventoryState === 'ready' && taskInventoryState === 'ready'
  const backupRequestCanRetry = !!backupRequestFailure && canOperate && backupRequestEvidenceReady && canRetryBackupRequest({
    action: backupRequestFailure.action,
    instanceStatus: item.status,
    hasActiveOperation,
    backupStatus: backupRequestBackup?.status,
    sameTemplateVersion: backupRequestBackup?.templateVersionId === item.templateVersionId,
    errorCode: backupRequestFailure.code,
  })
  const backupRequestActionLabel = backupRequestFailure
    ? t(backupRequestFailure.action === 'create' ? 'createBackup' : backupRequestFailure.action)
    : ''
  const backupRequestModalOpen = !!backupRequestFailure && (
    (backupRequestFailure.action === 'create' && backupCreateOpen) ||
    (backupRequestFailure.action !== 'create' && backupAction?.type === backupRequestFailure.action &&
      backupAction.backup.id === backupRequestFailure.backupId)
  )
  const backupRequestFailureDetails = backupRequestFailure && <div className="instance-action-request-description">
    <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{backupRequestFailure.message}</Typography.Text></div>
    <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t(`backupRequestImpact_${backupRequestFailure.action}`)}</Typography.Text></div>
    <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(backupRequestRecoveryKey(backupRequestFailure.code))}</Typography.Text></div>
  </div>
  const refreshBackupRequestState = async () => {
    try {
      setActioning('refresh-backup-request-state')
      await load()
    } finally {
      setActioning('')
    }
  }
  const retryBackupRequest = () => {
    if (!backupRequestFailure || !backupRequestCanRetry) return
    if (backupRequestFailure.action === 'create') {
      setBackupName(backupRequestFailure.backupName)
      setBackupCreateOpen(true)
      return
    }
    if (!backupRequestBackup) return
    setBackupConfirm('')
    setBackupAction({ type: backupRequestFailure.action, backup: backupRequestBackup })
  }
  const openBackupCreate = () => {
    setBackupRequestFailure(undefined)
    setBackupName('')
    setBackupCreateOpen(true)
  }
  const openBackupAction = (type: 'restore' | 'delete', backup: InstanceBackup) => {
    setBackupRequestFailure(undefined)
    setBackupConfirm('')
    setBackupAction({ type, backup })
  }
  const backupScheduleTime = backupPolicy ? `${String(backupPolicy.hour).padStart(2, '0')}:${String(backupPolicy.minute).padStart(2, '0')}` : ''
  const backupScheduleSummary = backupPolicy?.enabled
    ? backupPolicy.frequency === 'weekly'
      ? t('backupScheduleWeeklySummary', { weekday: t(`weekday_${backupPolicy.weekday}`), time: backupScheduleTime, timezone: backupPolicy.timezone })
      : t('backupScheduleDailySummary', { time: backupScheduleTime, timezone: backupPolicy.timezone })
    : t('backupScheduleDisabled')
  const backupScheduleWaiting = !!backupPolicy?.enabled && !!backupPolicy.nextRunAt && new Date(backupPolicy.nextRunAt).getTime() <= Date.now()
  const cleanupContinuationRequested = detailParams.get('cleanup') === 'review' && activeTab === 'backups'
  const failedBackupDeletes = failedBackupDeleteRecoveries(backups, tasks)
  const failedBackupDeleteTaskByBackupID = new Map(failedBackupDeletes.map(({ backup, task }) => [backup.id, task]))
  const cleanupEvidence = cleanupEvidenceState(backupInventoryState, taskInventoryState)
  const cleanupPhase = cleanupContinuationPhase({
    evidenceState: cleanupEvidence,
    backupStatuses: backups.map((backup) => backup.status),
    hasActiveTask,
    failedBackupDeleteCount: failedBackupDeletes.length,
  })
  const cleanupContinuationTone: 'info' | 'error' | 'warning' | 'success' = cleanupPhase === 'unavailable'
    ? 'error'
    : cleanupPhase === 'failed'
      ? 'error'
    : cleanupPhase === 'blocked'
      ? 'warning'
      : cleanupPhase === 'ready'
        ? 'success'
        : 'info'
  const cleanupContinuationDescription = cleanupPhase === 'loading'
    ? t('cleanupBackupContinuationLoading')
    : cleanupPhase === 'unavailable'
      ? t('cleanupBackupContinuationUnavailable', { error: backupInventoryError || taskInventoryError })
      : cleanupPhase === 'processing'
        ? t('cleanupBackupContinuationProcessing')
        : cleanupPhase === 'failed'
          ? t('cleanupBackupDeleteFailedSummary', { count: failedBackupDeletes.length })
        : cleanupPhase === 'blocked'
          ? t('cleanupBackupContinuationBlocked', { count: backups.length })
          : t('cleanupBackupContinuationReady')
  const clearCleanupContinuation = () => {
    const next = new URLSearchParams(detailParams)
    next.delete('cleanup')
    setCleanupRetryError('')
    setDetailParams(next, { replace: true })
  }
  const closeCleanupReview = () => {
    setCleanupOpen(false)
    if (detailParams.get('cleanup') === 'review') clearCleanupContinuation()
  }
  const cleanupContinuationPanel = cleanupContinuationRequested && <Alert
    className="cleanup-continuation-alert"
    type={cleanupContinuationTone}
    showIcon
    message={t('cleanupBackupContinuationTitle')}
    description={<div className="cleanup-continuation-body">
      <Typography.Text>{cleanupContinuationDescription}</Typography.Text>
      {!canOperate && <Typography.Text type="secondary">{t('cleanupBackupContinuationReadOnly')}</Typography.Text>}
      {cleanupPhase === 'failed' && <div className="cleanup-backup-failure-list">
        {failedBackupDeletes.map(({ backup, task }) => {
          const guidance = taskFailureGuidance(task)
          const recoveryPath = guidance.inspectHost ? taskHostRecoveryPathForTask(task) : undefined
          const retryKey = `retry-backup-delete:${task.id}`
          return <div className="cleanup-backup-failure" key={task.id}>
            <div className="cleanup-backup-failure-header">
              <div><Typography.Text type="secondary">{t('backup')}</Typography.Text><Typography.Text strong>{backup.name}</Typography.Text></div>
              <StatusTag value={task.status} />
            </div>
            <TaskFailureGuidance task={task} hostName={item.hostName} />
            <Space wrap className="cleanup-backup-failure-actions">
              {recoveryPath && <Button size="small" type="primary" icon={<CloudServerOutlined />} onClick={() => navigate(recoveryPath)}>{t('inspectFailedHost')}</Button>}
              {canOperate && !guidance.inspectHost && <Button size="small" type="primary" icon={<ReloadOutlined />} loading={actioning === retryKey} disabled={!!actioning && actioning !== retryKey} onClick={() => void retryBackupDelete(task)}>{t('retryBackupDelete')}</Button>}
              <Button size="small" onClick={() => navigate(`/tasks?task=${task.id}`)}>{t('viewTask')}</Button>
            </Space>
          </div>
        })}
      </div>}
      {cleanupRetryError && <div className="cleanup-backup-retry-error" role="alert">
        <Typography.Text strong type="danger">{t('cleanupBackupDeleteRetryFailed')}</Typography.Text>
        <Typography.Text type="danger">{cleanupRetryError}</Typography.Text>
        <Typography.Text type="secondary">{t('cleanupBackupDeleteRetryFailedHint')}</Typography.Text>
      </div>}
      <Space wrap className="cleanup-continuation-actions">
        {cleanupPhase === 'ready' && canOperate && <Button size="small" type="primary" icon={<SafetyCertificateOutlined />} disabled={!!actioning} onClick={() => setCleanupOpen(true)}>{t('continueCleanupReview')}</Button>}
        {cleanupPhase === 'processing' && activeCleanupTask && <Button size="small" onClick={() => navigate(`/tasks?task=${activeCleanupTask.id}`)}>{t('viewTask')}</Button>}
        {cleanupPhase !== 'loading' && <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>{t(cleanupPhase === 'unavailable' ? 'retry' : 'refreshStatus')}</Button>}
        <Button size="small" type="text" onClick={clearCleanupContinuation}>{t('exitCleanupGuide')}</Button>
      </Space>
    </div>}
  />
  const backupRequestFailurePanel = backupRequestFailure && !backupRequestModalOpen && <Alert
    className="backup-request-alert instance-action-request-alert"
    type="error"
    showIcon
    message={t('backupRequestFailed', { action: backupRequestActionLabel })}
    description={backupRequestFailureDetails}
    action={<Space wrap className="instance-action-request-actions">
      <Button size="small" icon={<ReloadOutlined />} loading={actioning === 'refresh-backup-request-state'} disabled={!!actioning && actioning !== 'refresh-backup-request-state'} onClick={() => void refreshBackupRequestState()}>{t('refreshStatus')}</Button>
      {backupRequestFailure.action !== 'delete' && <Button size="small" onClick={() => changeTab('logs')}>{t('viewInstanceLogs')}</Button>}
      {backupRequestFailure.code === 'not_found' && <Button size="small" onClick={() => navigate('/instances')}>{t('backToInstances')}</Button>}
      {backupRequestCanRetry && <Button size="small" type="primary" disabled={!!actioning} onClick={retryBackupRequest}>{t('retryBackupRequest', { action: backupRequestActionLabel })}</Button>}
      <Button size="small" type="text" onClick={() => setBackupRequestFailure(undefined)}>{t('dismiss')}</Button>
    </Space>}
  />
  const moreActions = [{ key: 'reconfigure', icon: <EditOutlined />, label: t('runtimeConfiguration'), disabled: !canReconfigure || !!actioning },{ key: 'upgrade', icon: <RocketOutlined />, label: t('upgrade'), disabled: !canUpgrade || !!actioning },{ type: 'divider' as const },{ key: 'cleanup', icon: <SafetyCertificateOutlined />, label: t('reviewCleanup'), danger: true, disabled: item.status === 'provisioning' || !!actioning }]
  const showBackupActions = canOperate || failedBackupDeletes.length > 0
  const backupColumns = [
    { title: t('name'), dataIndex: 'name', width: 220, ellipsis: true, render: (value: string, backup: InstanceBackup) => {
      const failedDeleteTask = failedBackupDeleteTaskByBackupID.get(backup.id)
      return <><Typography.Text strong>{value}</Typography.Text>{failedDeleteTask ? <><br /><Typography.Text type="danger">{t('backupDeleteFailedInline')}</Typography.Text></> : backup.errorMessage && <><br /><Typography.Text type="danger">{translateCode(t, backup.errorMessage, 'statusMessage')}</Typography.Text></>}</>
    } },
    { title: t('status'), dataIndex: 'status', width: 110, render: (value: string) => <StatusTag value={value} /> },
    { title: t('source'), dataIndex: 'creationType', width: 105, render: (value: InstanceBackup['creationType']) => <Tag>{t(value === 'scheduled' ? 'scheduledBackup' : 'manualBackup')}</Tag> },
    { title: t('version'), dataIndex: 'templateVersion', width: 105 },
    { title: t('size'), dataIndex: 'sizeBytes', width: 105, render: (value: number) => value > 0 ? bytes(value) : '—' },
    { title: t('sha256'), dataIndex: 'sha256', width: 165, render: (value: string) => value ? <Typography.Text code copyable={{ text: value }}>{value.slice(0, 12)}…</Typography.Text> : '—' },
    { title: t('createdBy'), dataIndex: 'createdByUsername', width: 130 },
    { title: t('createdAt'), dataIndex: 'createdAt', width: 180, render: (value: string) => formatDateTime(value, i18n.language, timezone) },
    ...(showBackupActions ? [{ title: '', width: 260, align: 'right' as const, fixed: 'right' as const, render: (_: unknown, backup: InstanceBackup) => {
      const failedDeleteTask = failedBackupDeleteTaskByBackupID.get(backup.id)
      return <Space>
        {failedDeleteTask && <Button size="small" onClick={() => navigate(`/tasks?task=${failedDeleteTask.id}`)}>{t('viewTask')}</Button>}
        {canOperate && <><Button size="small" icon={<UndoOutlined />} disabled={!!actioning || !canRestoreBackup(backup)} onClick={() => openBackupAction('restore', backup)}>{t('restore')}</Button><Button size="small" danger icon={<DeleteOutlined />} disabled={!!actioning || !['ready', 'failed'].includes(backup.status)} onClick={() => openBackupAction('delete', backup)}>{t('delete')}</Button></>}
      </Space>
    } }] : []),
  ]
  const backupsTab = <Card title={t('backups')} extra={canOperate ? <Button type="primary" icon={<SaveOutlined />} disabled={!canCreateBackup || !!actioning} onClick={openBackupCreate}>{t('createBackup')}</Button> : undefined}>
    {cleanupContinuationPanel}
    {backupRequestFailurePanel}
    <Alert className="backup-storage-alert" type="info" showIcon message={t('coldBackupNotice')} description={t('coldBackupNoticeHint')} />
    <Card size="small" className="backup-policy-card">
      <div className="backup-policy-summary">
        <div className={`backup-policy-icon ${backupPolicy?.enabled ? 'is-enabled' : ''}`}><ClockCircleOutlined /></div>
        <div className="backup-policy-copy">
          <Space wrap><Typography.Text strong>{t('automaticBackups')}</Typography.Text><Tag color={backupPolicy?.enabled ? 'green' : 'default'}>{backupPolicy?.enabled ? t('enabled') : t('disabled')}</Tag></Space>
          <Typography.Text type="secondary">{backupScheduleSummary}</Typography.Text>
          {backupPolicy?.enabled && <Typography.Text type="secondary">{t('backupRetentionSummary', { count: backupPolicy.retentionCount })}</Typography.Text>}
        </div>
        {canOperate && <Button icon={<EditOutlined />} onClick={showBackupPolicy}>{t('configure')}</Button>}
      </div>
      {backupPolicy?.enabled && backupPolicy.nextRunAt && <Descriptions className="backup-policy-facts" size="small" column={{ xs: 1, md: 3 }} items={[
        { key: 'next', label: t('nextBackupRun'), children: backupScheduleWaiting ? <Typography.Text type="warning">{t('backupScheduleWaiting')}</Typography.Text> : formatDateTime(backupPolicy.nextRunAt, i18n.language, timezone) },
        { key: 'last', label: t('lastBackupRun'), children: backupPolicy.lastRunAt ? formatDateTime(backupPolicy.lastRunAt, i18n.language, timezone) : t('notRunYet') },
        { key: 'owner', label: t('configuredBy'), children: backupPolicy.configuredByUsername },
      ]} />}
      {backupPolicy?.lastStatus === 'failed' && <Alert className="backup-policy-error" type="error" showIcon message={t('lastScheduledBackupFailed')} description={backupPolicy.lastError || t('viewTaskForDetails')} action={backupPolicy.lastTaskId ? <Button size="small" onClick={() => navigate(`/tasks?task=${backupPolicy.lastTaskId}`)}>{t('viewTask')}</Button> : undefined} />}
    </Card>
    <Table<InstanceBackup> rowKey="id" dataSource={backups} columns={backupColumns} pagination={false} scroll={{ x: showBackupActions ? 1380 : 1120 }} locale={{ emptyText: <EmptyState compact description={t('backupsEmptyDescription')} /> }} />
  </Card>
  const copyDeploymentAvailable = !!currentVersion && currentVersion.selectable !== false
  const detailActions = canOperate ? <Space wrap><Button icon={<CopyOutlined />} disabled={!copyDeploymentAvailable} title={!copyDeploymentAvailable ? t('copyDeploymentUnavailableHint') : undefined} onClick={() => navigate(`/instances?create=1&copy=${encodeURIComponent(item.id)}`)}>{t('copyDeployment')}</Button><Button icon={<EditOutlined />} disabled={!!actioning || !!operationTask} onClick={showEdit}>{t('edit')}</Button>{canStart && <Button type="primary" icon={<PlayCircleOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('start')}>{t('start')}</Button>}{canStopOrRestart && <Button icon={<PauseCircleOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('stop')}>{t('stop')}</Button>}{canStopOrRestart && <Button icon={<ReloadOutlined />} disabled={!!actioning} onClick={() => openLifecycleConfirmation('restart')}>{t('restart')}</Button>}<Dropdown menu={{ items: moreActions, onClick: ({ key }) => key === 'reconfigure' ? showRuntimeConfiguration() : key === 'upgrade' ? showUpgrade() : setCleanupOpen(true) }} trigger={['click']}><Button icon={<MoreOutlined />} disabled={!!actioning}>{t('moreActions')}</Button></Dropdown></Space> : undefined
  return <><PageHeader title={<Space><Button type="text" aria-label={t('instances')} title={t('instances')} icon={<LeftOutlined />} onClick={() => navigate('/instances')} /><DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" />{item.name}<StatusTag value={item.status} /></Space>} description={`${item.templateName} ${item.templateVersion} · ${item.hostName}`} />{pageError && <Alert className="instance-page-alert" type="warning" showIcon message={t('instanceRefreshFailed')} description={pageError} action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} />}{lifecycleRequestFailurePanel}{changeRequestFailurePanel}{taskRetryRequestPanel}{restoreOutcomePanel}{restoreVerificationPanel}{operationPanel}{deploymentReadyPanel}<Tabs className="instance-detail-tabs" activeKey={activeTab} onChange={changeTab} tabBarExtraContent={detailActions} items={[{ key: 'overview', label: t('details'), children: overview },{ key: 'connection', label: t('connection'), children: connectionTab },{ key: 'logs', label: t('logs'), children: logsTab },{ key: 'metrics', label: t('metrics'), children: metricsTab },{ key: 'backups', label: `${t('backups')} (${backupInventoryState === 'ready' ? backups.length : '—'})`, children: backupsTab }]} />
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
      <div className="instance-bulk-confirm">
        <Alert
          type={lifecycleConfirmAction === 'stop' || lifecycleConfirmAction === 'restart' ? 'warning' : 'info'}
          showIcon
          message={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'instanceStopConfirmMessage' : lifecycleConfirmAction === 'restart' ? 'instanceRestartConfirmMessage' : 'instanceStartConfirmMessage') : ''}
          description={lifecycleConfirmAction ? t(lifecycleConfirmAction === 'stop' ? 'instanceStopConfirmImpact' : lifecycleConfirmAction === 'restart' ? 'instanceRestartConfirmImpact' : 'instanceStartConfirmImpact') : ''}
        />
        <div>
          <Typography.Text strong>{t('instanceActionTarget')}</Typography.Text>
          <Space size={[6, 6]} wrap className="instance-bulk-name-list"><Tag>{item.name} · {translateCode(t, item.status)}</Tag></Space>
        </div>
        {lifecycleRequestFailure && lifecycleRequestFailure.action === lifecycleConfirmAction && <Alert
          type="error"
          showIcon
          message={t('instanceActionRequestFailed', { action: t(lifecycleRequestFailure.action) })}
          description={<div className="instance-action-request-description">
            <div><Typography.Text type="secondary">{t('failureCause')}</Typography.Text><Typography.Text>{lifecycleRequestFailure.message}</Typography.Text></div>
            <div><Typography.Text type="secondary">{t('failureImpact')}</Typography.Text><Typography.Text>{t('instanceActionRequestImpact')}</Typography.Text></div>
            <div><Typography.Text type="secondary">{t('recoveryAdvice')}</Typography.Text><Typography.Text>{t(instanceLifecycleRequestRecoveryKey(lifecycleRequestFailure.code))}</Typography.Text></div>
          </div>}
        />}
      </div>
    </Modal>
    <Modal title={t('edit')} open={editOpen} onCancel={() => { if (!editSaving) setEditOpen(false) }} onOk={() => void saveEdit()} confirmLoading={editSaving} okText={t('save')} width={620}>
      <Form form={editForm} layout="vertical">
        <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} /></Form.Item>
        <Form.Item name="purpose" label={t('purpose')} extra={t('purposeHint')} rules={[{ max: 500 }]}><Input.TextArea rows={2} maxLength={500} showCount /></Form.Item>
        <div className="form-grid"><Form.Item name="projectId" label={t('project')}><Select allowClear options={projects.map((project) => ({ value: project.id, label: project.name }))} /></Form.Item><Form.Item name="environment" label={t('environment')} rules={[{ required: true }]}><Select options={['development', 'testing', 'staging', 'production'].map((value) => ({ value, label: translateCode(t, value) }))} /></Form.Item></div>
        <div className="form-grid"><Form.Item name="owner" label={t('owner')} rules={[{ required: true, whitespace: true, max: 120 }]}><Input maxLength={120} /></Form.Item><Form.Item name="expiresAt" label={t('expectedExpiry')} extra={t('expectedExpiryHint')}><DatePicker showTime minuteStep={15} allowClear style={{ width: '100%' }} /></Form.Item></div>
        <Form.Item name="labels" label={t('labels')} rules={[{ validator: (_, value?: string) => parseLabelText(value) ? Promise.resolve() : Promise.reject(new Error(t('invalidLabels'))) }]}><Input placeholder={t('labelsPlaceholder')} /></Form.Item>
      </Form>
    </Modal>
    <Modal className="instance-change-modal" title={t('runtimeConfiguration')} open={runtimeOpen} onCancel={() => { if (!actioning) setRuntimeOpen(false) }} onOk={() => void submitRuntimeConfiguration()} confirmLoading={actioning === 'reconfigure'} okText={t('applyConfiguration')} okButtonProps={{ disabled: !runtimeReady || !!operationTask || (!!changeRequestFailure && changeRequestFailure.action === 'reconfigure' && !changeRequestCanRetry) }} width={680} destroyOnHidden>
      <Alert className="backup-modal-alert" type={item.status === 'stopped' ? 'info' : 'warning'} showIcon message={item.status === 'stopped' ? t('runtimeStoppedNotice') : t('runtimeDowntimeNotice')} description={t('runtimeRecoveryNotice')} />
      {changeRequestFailure?.action === 'reconfigure' && changeRequestModalFailure}
      <Form form={runtimeForm} layout="vertical" requiredMark={false}>
        <Row gutter={16}>
          <Col span={8}><Form.Item name="cpu" label={t('cpu')} rules={[{ required: true }]}><InputNumber min={currentVersion?.minCpu || .25} step={.25} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="memoryGiB" label={`${t('memory')} GiB`} rules={[{ required: true }]}><InputNumber min={(currentVersion?.minMemoryBytes || 0) / 1024 ** 3} step={.5} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="diskGiB" label={`${t('disk')} GiB`} rules={[{ required: true }]}><InputNumber min={(currentVersion?.minDiskBytes || 0) / 1024 ** 3} step={1} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
        <Descriptions size="small" bordered column={1} items={[
          { key: 'current', label: t('currentReservation'), children: `${item.cpu} CPU · ${bytes(item.memoryBytes)} · ${bytes(item.reservedDiskBytes)}` },
          { key: 'requested', label: t('requestedReservation'), children: `${runtimeTarget.cpu} CPU · ${bytes(runtimeTarget.memory)} · ${bytes(runtimeTarget.disk)}` },
        ]} />
        <Form.Item className="upgrade-field" name="autoRestart" label={t('autoRestart')} valuePropName="checked" extra={t('autoRestartRuntimeHint')}><Switch checkedChildren={t('enabled')} unCheckedChildren={t('disabled')} /></Form.Item>
        <Form.Item className="upgrade-field" name="extraEnvironment" label={t('extraEnvironment')} rules={[{ validator: (_, value?: string) => parseStringMap(value) ? Promise.resolve() : Promise.reject(new Error(t('invalidJSONObject'))) }]}>
          <Input.TextArea rows={6} placeholder={'{\n  "TZ": "Asia/Shanghai"\n}'} />
        </Form.Item>
        {!runtimeChanged ? <Alert type="info" showIcon message={t('runtimeNoChanges')} /> : !runtimeMinimumReady ? <Alert type="warning" showIcon message={t('runtimeBelowMinimum')} /> : !runtimeCapacityReady ? <Alert type="warning" showIcon message={t('runtimeCapacityUnavailable')} description={t('runtimeCapacityUnavailableHint')} /> : runtimeRemaining && <Alert type="success" showIcon message={t('runtimeCapacityReady')} description={t('runtimeCapacityPreview', { name: instanceHost?.name || item.hostName, cpu: runtimeRemaining.cpu.toFixed(runtimeRemaining.cpu % 1 ? 1 : 0), memory: bytes(runtimeRemaining.memory), disk: bytes(runtimeRemaining.disk) })} />}
      </Form>
    </Modal>
    <InstanceCleanupReviewModal
      instanceId={item.id}
      instanceName={item.name}
      open={cleanupOpen}
      onClose={closeCleanupReview}
      onChanged={load}
      onDeleteQueued={(task) => navigate(`/tasks?task=${encodeURIComponent(task.id)}`)}
    />
    <Modal className="instance-change-modal" title={t('upgrade')} open={upgradeOpen} onCancel={() => { if (!actioning) setUpgradeOpen(false) }} onOk={submitUpgrade} confirmLoading={actioning === 'upgrade'} okButtonProps={{ disabled: !upgradeReady || !!operationTask || (!!changeRequestFailure && changeRequestFailure.action === 'upgrade' && !changeRequestCanRetry) }} destroyOnHidden>
      <Typography.Paragraph type="secondary">{t('upgradeHint')}</Typography.Paragraph>
      {changeRequestFailure?.action === 'upgrade' && changeRequestModalFailure}
      <div className="upgrade-field">
        <Typography.Text strong>{t('version')}</Typography.Text>
        <Select aria-label={t('version')} style={{ width: '100%' }} options={upgradeOptions} value={upgradeVersion} onChange={(value) => { setUpgradeVersion(value); setUpgradeImageArtifactID(undefined); setUpgradeRegistryID(undefined) }} placeholder={t('version')} />
      </div>
      {upgradeOptions.length === 0 && <Alert type="warning" showIcon message={t('noCompatibleVersion')} />}
      {upgradeTarget && <div className="upgrade-source-panel">
        <Typography.Text strong>{t('upgradeImageSource')}</Typography.Text>
        <Radio.Group className="upgrade-source-options" optionType="button" buttonStyle="solid" value={upgradeImageSource} options={[{ value: 'public', label: t('publicRegistry') }, { value: 'registry', label: t('configuredRegistry') }, { value: 'offline', label: t('offlineImage') }]} onChange={(event) => { setUpgradeImageSource(event.target.value); setUpgradeImageArtifactID(undefined); setUpgradeRegistryID(undefined) }} />
        {upgradeImageSource === 'public' && <Alert type="info" showIcon message={t('pullUpgradeImage')} description={upgradeTarget.imageReference} />}
        {upgradeImageSource === 'offline' && <>
          <Select aria-label={t('offlineImage')} value={upgradeImageArtifactID} onChange={setUpgradeImageArtifactID} placeholder={t('selectCompatibleUpgradeImage')} options={upgradeCompatibleImages.map((image) => ({ value: image.id, label: `${image.name} · ${bytes(image.sizeBytes)} · ${image.architectures.join(' / ')}` }))} />
          {upgradeCompatibleImages.length === 0 && <Alert type="warning" showIcon message={t('noCompatibleUpgradeImages')} description={t('noCompatibleUpgradeImagesHint', { image: upgradeTarget.imageReference, architecture: instanceHost?.architecture || '—' })} action={<Button size="small" onClick={() => navigate('/images')}>{t('uploadImage')}</Button>} />}
        </>}
        {upgradeImageSource === 'registry' && <>
          <Select aria-label={t('registry')} value={upgradeRegistryID} onChange={setUpgradeRegistryID} placeholder={t('selectRegistryForHost', { host: imageRegistryHost(upgradeTarget.imageReference) })} options={upgradeCompatibleRegistries.map((registry) => ({ value: registry.id, disabled: ['offline', 'degraded'].includes(registry.status), label: <Space><span>{registry.name}</span><StatusTag value={registry.status} /></Space> }))} />
          {upgradeCompatibleRegistries.length === 0 ? <Alert type="warning" showIcon message={t('noMatchingUpgradeRegistries')} description={t('noMatchingRegistriesHint', { host: imageRegistryHost(upgradeTarget.imageReference) })} action={<Button size="small" onClick={() => navigate('/images?tab=registries')}>{t('addRegistry')}</Button>} /> : upgradeRegistry && <Alert type={upgradeRegistry.status === 'online' ? 'success' : 'info'} showIcon message={t('registryMatchesImageSource', { host: imageRegistryHost(upgradeTarget.imageReference) })} description={upgradeRegistry.statusMessage ? t(upgradeRegistry.statusMessage) : t('registryWillBeVerifiedOnTarget')} />}
        </>}
      </div>}
    </Modal>
    <Modal title={t('automaticBackups')} open={backupPolicyOpen} onCancel={() => { if (!backupPolicySaving) setBackupPolicyOpen(false) }} onOk={() => void saveBackupPolicy()} confirmLoading={backupPolicySaving} okText={t('save')} width={640} destroyOnHidden>
      <Alert className="backup-modal-alert" type="warning" showIcon message={t('scheduledBackupDowntimeWarning')} description={t('scheduledBackupDowntimeHint')} />
      <Form form={backupPolicyForm} layout="vertical" requiredMark={false}>
        <Form.Item name="enabled" label={t('automaticBackups')} valuePropName="checked"><Switch checkedChildren={t('enabled')} unCheckedChildren={t('disabled')} /></Form.Item>
        <Row gutter={16}>
          <Col xs={24} sm={backupPolicyFrequency === 'weekly' ? 12 : 24}><Form.Item name="frequency" label={t('frequency')} rules={[{ required: true }]}><Select options={[{ value: 'daily', label: t('daily') }, { value: 'weekly', label: t('weekly') }]} /></Form.Item></Col>
          {backupPolicyFrequency === 'weekly' && <Col xs={24} sm={12}><Form.Item name="weekday" label={t('weekday')} rules={[{ required: true }]}><Select options={Array.from({ length: 7 }, (_, value) => ({ value, label: t(`weekday_${value}`) }))} /></Form.Item></Col>}
        </Row>
        <Row gutter={16}>
          <Col xs={24} sm={8}><Form.Item name="hour" label={t('hour')} rules={[{ required: true }]}><Select options={Array.from({ length: 24 }, (_, value) => ({ value, label: String(value).padStart(2, '0') }))} /></Form.Item></Col>
          <Col xs={24} sm={8}><Form.Item name="minute" label={t('minute')} rules={[{ required: true }]}><Select options={[0, 15, 30, 45].map((value) => ({ value, label: String(value).padStart(2, '0') }))} /></Form.Item></Col>
          <Col xs={24} sm={8}><Form.Item name="retentionCount" label={t('retentionCount')} rules={[{ required: true, type: 'number', min: 1, max: 100 }]}><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
        <Form.Item name="timezone" label={t('timezone')} rules={[{ required: true }, { validator: (_, value) => isValidTimezone(value) ? Promise.resolve() : Promise.reject(new Error(t('timezoneInvalid'))) }]}>
          <AutoComplete options={commonTimezones.map((value) => ({ value }))} filterOption={(input, option) => String(option?.value || '').toLowerCase().includes(input.toLowerCase())} />
        </Form.Item>
        <Alert type={backupPolicyEnabled ? 'info' : 'success'} showIcon message={backupPolicyEnabled ? t('backupPolicyEnabledHint') : t('backupPolicyDisabledHint')} description={backupPolicyEnabled ? t('backupRetentionOnlyScheduledHint') : undefined} />
      </Form>
    </Modal>
    <Modal title={t('createBackup')} open={backupCreateOpen} onCancel={() => { if (!actioning) { setBackupCreateOpen(false); setBackupName('') } }} onOk={() => void createBackup()} confirmLoading={actioning === 'backup-create'} okText={t('createBackup')} okButtonProps={{ disabled: !canCreateBackup || (backupRequestFailure?.action === 'create' && !backupRequestCanRetry) }}>
      <Alert className="backup-modal-alert" type="warning" showIcon message={t('backupDowntimeWarning')} description={t('backupDowntimeWarningHint')} />
      {backupRequestFailure?.action === 'create' && <Alert className="backup-modal-alert backup-request-modal-alert" type="error" showIcon message={t('backupRequestFailed', { action: backupRequestActionLabel })} description={backupRequestFailureDetails} />}
      <Typography.Paragraph type="secondary">{t('backupNameHint')}</Typography.Paragraph>
      <Input autoFocus aria-label={t('backupName')} value={backupName} maxLength={120} onChange={(event) => setBackupName(event.target.value)} placeholder={t('backupNamePlaceholder')} />
    </Modal>
    <Modal title={backupAction?.type === 'restore' ? t('restoreBackup') : t('deleteBackup')} open={!!backupAction} onCancel={() => { if (!actioning) { setBackupAction(undefined); setBackupConfirm('') } }} onOk={() => void submitBackupAction()} confirmLoading={actioning === `backup-${backupAction?.type}`} okText={backupAction?.type === 'restore' ? t('restore') : t('delete')} okButtonProps={{ danger: true, disabled: !backupAction || backupConfirm !== (backupAction.type === 'restore' ? item.name : backupAction.backup.name) || (!!backupRequestFailure && backupRequestFailure.action === backupAction.type && backupRequestFailure.backupId === backupAction.backup.id && !backupRequestCanRetry) }}>
      {backupAction?.type === 'restore' ? <Alert className="backup-modal-alert" type="error" showIcon message={t('restoreBackupWarning')} description={t('restoreBackupWarningHint', { name: backupAction.backup.name })} /> : <Alert className="backup-modal-alert" type="warning" showIcon message={t('deleteBackupWarning')} description={t('deleteBackupWarningHint')} />}
      {backupRequestFailure && backupAction && backupRequestFailure.action === backupAction.type && backupRequestFailure.backupId === backupAction.backup.id && <Alert className="backup-modal-alert backup-request-modal-alert" type="error" showIcon message={t('backupRequestFailed', { action: backupRequestActionLabel })} description={backupRequestFailureDetails} />}
      {backupAction && <Typography.Paragraph>{backupAction.type === 'restore' ? t('restoreBackupConfirmHint', { name: item.name }) : t('deleteBackupConfirmHint', { name: backupAction.backup.name })}</Typography.Paragraph>}
      <Input autoFocus aria-label={backupAction?.type === 'restore' ? t('restoreBackupConfirmLabel') : t('deleteBackupConfirmLabel')} value={backupConfirm} onChange={(event) => setBackupConfirm(event.target.value)} />
    </Modal>
  </>
}
