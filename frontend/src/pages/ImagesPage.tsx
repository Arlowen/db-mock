import {
  CheckCircleOutlined,
  ClearOutlined,
  CloudServerOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  FileZipOutlined,
  PlusOutlined,
  ReloadOutlined,
  RocketOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  Upload,
} from 'antd'
import type { UploadFile } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { ApiError, api, discardImageUpload, errorMessage, uploadInChunks } from '../lib/api'
import type { ImageUploadPhase } from '../lib/api'
import { isRegistryURL } from '../lib/image-source'
import { formatDateTime } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import type { DatabaseTemplate, Host, ImageArtifact, Registry } from '../lib/types'
import { bytes } from '../lib/types'
import { defaultUploadSettings, normalizeUploadSettings, type UploadSettings } from '../lib/upload-settings'

interface UploadValues {
  name: string
  expectedSha256?: string
}

interface RegistryValues {
  name: string
  url: string
  username?: string
  password?: string
  caCertificate?: string
  clearPassword?: boolean
  clearCaCertificate?: boolean
}

interface RegistryTestResult {
  status: string
  message: string
  statusCode?: number
  checkedAt: string
}

interface ImageCleanupPreview {
  items: ImageArtifact[]
  totalBytes: number
  olderThanDays: number
  cutoff: string
}

interface ImageCleanupResult {
  deletedCount: number
  skippedCount: number
  failedCount: number
  freedBytes: number
}

function archiveName(filename: string): string {
  return filename.replace(/\.(?:tar\.gz|tgz|tar)$/i, '')
}

function matchingVersions(image: ImageArtifact, templates: DatabaseTemplate[]) {
  return templates.flatMap((template) => template.versions
    .filter((version) => image.imageRefs.includes(version.imageReference) && image.architectures.some((architecture) => version.architectures.includes(architecture)))
    .map((version) => ({ template, version })))
}

export function ImagesPage() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const { timezone } = useSystemSettings()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [images, setImages] = useState<ImageArtifact[]>([])
  const [registries, setRegistries] = useState<Registry[]>([])
  const [templates, setTemplates] = useState<DatabaseTemplate[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [activeTab, setActiveTab] = useState(params.get('tab') === 'registries' ? 'registries' : 'images')
  const [search, setSearch] = useState('')
  const [architecture, setArchitecture] = useState('')
  const [status, setStatus] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadSettings, setUploadSettings] = useState<UploadSettings>(defaultUploadSettings)
  const [uploadError, setUploadError] = useState('')
  const [uploadPhase, setUploadPhase] = useState<ImageUploadPhase | 'idle' | 'paused' | 'error'>('idle')
  const [savingRegistry, setSavingRegistry] = useState(false)
  const [testingRegistry, setTestingRegistry] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [uploadDraftDirty, setUploadDraftDirty] = useState(false)
  const [registryDraftDirty, setRegistryDraftDirty] = useState(false)
  const [selectedImage, setSelectedImage] = useState<ImageArtifact | null>(null)
  const [editingRegistry, setEditingRegistry] = useState<Registry | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupDays, setCleanupDays] = useState(30)
  const [cleanupPreview, setCleanupPreview] = useState<ImageCleanupPreview | null>(null)
  const [selectedCleanupIDs, setSelectedCleanupIDs] = useState<string[]>([])
  const [scanningCleanup, setScanningCleanup] = useState(false)
  const [cleaningImages, setCleaningImages] = useState(false)
  const [file, setFile] = useState<UploadFile | null>(null)
  const [progress, setProgress] = useState(0)
  const [uploadForm] = Form.useForm<UploadValues>()
  const [registryForm] = Form.useForm<RegistryValues>()
  const uploadAbort = useRef<AbortController | null>(null)
  const cleanupScanRequest = useRef(0)

  const load = useCallback(async () => {
    try {
      setPageError('')
      const [imageResponse, registryResponse, templateResponse, hostResponse, settingsResponse] = await Promise.all([
        api<{ items: ImageArtifact[] }>('/images'),
        api<{ items: Registry[] }>('/registries'),
        api<{ items: DatabaseTemplate[] }>('/templates'),
        api<{ items: Host[] }>('/hosts'),
        api<Record<string, unknown>>('/settings'),
      ])
      setImages(imageResponse.items)
      setRegistries(registryResponse.items)
      setTemplates(templateResponse.items)
      setHosts(hostResponse.items)
      setUploadSettings(normalizeUploadSettings(settingsResponse.uploads))
    } catch (error) {
      setPageError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => { setActiveTab(params.get('tab') === 'registries' ? 'registries' : 'images') }, [params])

  const changeTab = (value: string) => {
    const next = new URLSearchParams(params)
    if (value === 'registries') next.set('tab', value); else next.delete('tab')
    setActiveTab(value)
    setParams(next, { replace: true })
  }

  const architectures = useMemo(() => Array.from(new Set(images.flatMap((item) => item.architectures))).sort(), [images])
  const filteredImages = useMemo(() => {
    const query = search.trim().toLowerCase()
    return images.filter((item) => {
      const matchesSearch = !query || [item.name, item.filename, item.sha256, ...item.imageRefs].some((value) => value.toLowerCase().includes(query))
      const matchesArchitecture = !architecture || item.architectures.includes(architecture)
      const matchesStatus = !status || item.status === status
      return matchesSearch && matchesArchitecture && matchesStatus
    })
  }, [architecture, images, search, status])
  const hasImageFilters = !!(search || architecture || status)
  const fileTooLarge = !!file?.originFileObj && file.originFileObj.size > uploadSettings.maxBytes
  const selectedCleanupItems = cleanupPreview?.items.filter((item) => selectedCleanupIDs.includes(item.id)) ?? []
  const selectedCleanupBytes = selectedCleanupItems.reduce((total, item) => total + item.sizeBytes, 0)

  const resetImageFilters = () => {
    setSearch('')
    setArchitecture('')
    setStatus('')
  }

  const showImageUpload = () => {
    setFile(null)
    setProgress(0)
    setUploadError('')
    setUploadPhase('idle')
    uploadForm.resetFields()
    setUploadDraftDirty(false)
    setImageOpen(true)
  }

  const showRegistry = (item?: Registry) => {
    setEditingRegistry(item ?? null)
    registryForm.setFieldsValue(item ? {
      name: item.name,
      url: item.url,
      username: item.username ?? '',
      password: '',
      caCertificate: '',
      clearPassword: false,
      clearCaCertificate: false,
    } : { name: '', url: '', username: '', password: '', caCertificate: '', clearPassword: false, clearCaCertificate: false })
    setRegistryDraftDirty(false)
    setRegistryOpen(true)
  }

  const changeFile = (nextFile: UploadFile | null) => {
    setUploadDraftDirty(true)
    setFile(nextFile)
    const nativeFile = nextFile?.originFileObj
    setUploadError(nativeFile && nativeFile.size > uploadSettings.maxBytes ? t('imageFileTooLarge', { size: bytes(nativeFile.size), max: bytes(uploadSettings.maxBytes) }) : '')
    setProgress(0)
    setUploadPhase('idle')
    if (nextFile && !uploadForm.getFieldValue('name')) uploadForm.setFieldValue('name', archiveName(nextFile.name))
  }

  const upload = async () => {
    if (!file?.originFileObj) return
    if (file.originFileObj.size > uploadSettings.maxBytes) {
      setUploadError(t('imageFileTooLarge', { size: bytes(file.originFileObj.size), max: bytes(uploadSettings.maxBytes) }))
      return
    }
    const controller = new AbortController()
    uploadAbort.current = controller
    try {
      const values = await uploadForm.validateFields()
      setUploading(true)
      setUploadError('')
      const uploadedImage = await uploadInChunks(file.originFileObj, setProgress, values.expectedSha256?.trim().toLowerCase() ?? '', values.name.trim(), setUploadPhase, controller.signal, uploadSettings.chunkBytes)
      message.success(t('imageUploadComplete'))
      setUploadDraftDirty(false)
      setImageOpen(false)
      setFile(null)
      setProgress(0)
      uploadForm.resetFields()
      await load()
      setSelectedImage(uploadedImage)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setUploadPhase('paused')
        message.info(t('imageUploadPaused'))
      } else if (error instanceof Error) {
        setUploadPhase('error')
        if (error instanceof ApiError && error.status === 400) setProgress(0)
        setUploadError(errorMessage(error))
      }
    } finally {
      uploadAbort.current = null
      setUploading(false)
    }
  }

  const pauseUpload = () => uploadAbort.current?.abort()
  const finishCloseImageUpload = () => {
    setImageOpen(false)
    setFile(null)
    setProgress(0)
    setUploadError('')
    setUploadPhase('idle')
    setUploadDraftDirty(false)
    uploadForm.resetFields()
  }
  const closeImageUpload = () => {
    if (uploading) { pauseUpload(); return }
    if (!uploadDraftDirty) { finishCloseImageUpload(); return }
    modal.confirm({
      title: t('discardImageUploadDraftTitle'),
      content: t('discardImageUploadDraftHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseImageUpload,
    })
  }
  const discardUpload = async () => {
    if (!file?.originFileObj) return
    try {
      await discardImageUpload(file.originFileObj)
      setProgress(0)
      setUploadError('')
      setUploadPhase('idle')
      message.success(t('imageUploadDiscarded'))
    } catch (error) { message.error(errorMessage(error)) }
  }

  const finishCloseRegistry = () => {
    setRegistryOpen(false)
    setEditingRegistry(null)
    setRegistryDraftDirty(false)
    registryForm.resetFields()
  }
  const closeRegistry = () => {
    if (savingRegistry) return
    if (!registryDraftDirty) { finishCloseRegistry(); return }
    modal.confirm({
      title: t('discardRegistryChangesTitle'),
      content: t('discardRegistryChangesHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseRegistry,
    })
  }

  const saveRegistry = async () => {
    try {
      setSavingRegistry(true)
      const values = await registryForm.validateFields()
      const saved = await api<Registry>(editingRegistry ? `/registries/${editingRegistry.id}` : '/registries', {
        method: editingRegistry ? 'PUT' : 'POST',
        body: values,
      })
      message.success(t('saved'))
      setRegistryDraftDirty(false)
      setRegistryOpen(false)
      setEditingRegistry(null)
      registryForm.resetFields()
      await load()
      void testRegistry(saved)
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally {
      setSavingRegistry(false)
    }
  }

  const testRegistry = async (item: Registry) => {
    try {
      setTestingRegistry(item.id)
      const result = await api<RegistryTestResult>(`/registries/${item.id}/test`, { method: 'POST' })
      setRegistries((current) => current.map((registry) => registry.id === item.id ? { ...registry, status: result.status, statusMessage: result.message, statusCode: result.statusCode, lastTestedAt: result.checkedAt } : registry))
      if (result.status === 'online') message.success(t('registryTestSuccess'))
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setTestingRegistry('')
    }
  }

  const removeImage = async (item: ImageArtifact) => {
    try {
      await api(`/images/${item.id}`, { method: 'DELETE' })
      if (selectedImage?.id === item.id) setSelectedImage(null)
      message.success(t('imageDeleted'))
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const scanUnusedImages = async (days = cleanupDays) => {
    const requestID = ++cleanupScanRequest.current
    try {
      setScanningCleanup(true)
      const result = await api<ImageCleanupPreview>(`/images/unused?olderThanDays=${days}`)
      if (cleanupScanRequest.current !== requestID) return
      setCleanupPreview(result)
      setSelectedCleanupIDs(result.items.slice(0, 200).map((item) => item.id))
    } catch (error) {
      if (cleanupScanRequest.current !== requestID) return
      message.error(errorMessage(error))
      setCleanupPreview(null)
      setSelectedCleanupIDs([])
    } finally {
      if (cleanupScanRequest.current === requestID) setScanningCleanup(false)
    }
  }

  const showImageCleanup = () => {
    setCleanupDays(30)
    setCleanupPreview(null)
    setSelectedCleanupIDs([])
    setCleanupOpen(true)
    void scanUnusedImages(30)
  }

  const cleanupUnusedImages = async () => {
    if (!selectedCleanupIDs.length) return
    try {
      setCleaningImages(true)
      const result = await api<ImageCleanupResult>('/images/cleanup', { method: 'POST', body: { imageIds: selectedCleanupIDs, olderThanDays: cleanupDays, confirm: 'DELETE' } })
      if (result.failedCount > 0) {
        message.warning(t('imageCleanupPartial', { deleted: result.deletedCount, failed: result.failedCount }))
      } else if (result.skippedCount > 0) {
        message.warning(t('imageCleanupSkipped', { deleted: result.deletedCount, skipped: result.skippedCount }))
      } else {
        message.success(t('imageCleanupSuccess', { count: result.deletedCount, size: bytes(result.freedBytes) }))
      }
      await Promise.all([load(), scanUnusedImages(cleanupDays)])
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setCleaningImages(false)
    }
  }

  const removeRegistry = async (item: Registry) => {
    try {
      await api(`/registries/${item.id}`, { method: 'DELETE' })
      message.success(t('registryDeleted'))
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    }
  }

  const imageEmpty = hasImageFilters
    ? <EmptyState compact action={resetImageFilters} actionLabel={t('clearFilters')} description={t('imagesFilteredEmptyDescription')} />
    : <EmptyState compact action={canOperate ? showImageUpload : undefined} actionLabel={canOperate ? t('uploadImage') : undefined} description={t('imagesEmptyDescription')} />
  const showImageFilters = images.length > 0 || hasImageFilters
  const imageListActions = <Space wrap><Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>{canOperate && <>{images.length > 0 && <Button icon={<ClearOutlined />} onClick={showImageCleanup}>{t('scanUnusedImages')}</Button>}<Button type="primary" icon={<CloudUploadOutlined />} onClick={showImageUpload}>{t('uploadImage')}</Button></>}</Space>

  const selectedMatches = selectedImage ? matchingVersions(selectedImage, templates) : []
  const selectedCompatibleHosts = selectedImage ? hosts.filter((host) => host.status === 'online' && !host.maintenance && selectedImage.architectures.includes(host.architecture || '')) : []
  const primaryMatch = selectedMatches[0]
  const createWithSelectedImage = () => {
    if (!selectedImage || !primaryMatch) return
    navigate(`/instances?create=1&template=${encodeURIComponent(primaryMatch.version.id)}&image=${encodeURIComponent(selectedImage.id)}`)
  }

  const imageTab = <>
    {showImageFilters && <Card className="image-toolbar-card" size="small">
      <div className="image-toolbar">
        <Input
          allowClear
          aria-label={t('search')}
          prefix={<SearchOutlined />}
          placeholder={t('imageSearchPlaceholder')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label={t('architecture')}
          value={architecture}
          onChange={setArchitecture}
          options={[{ value: '', label: t('allArchitectures') }, ...architectures.map((value) => ({ value, label: value }))]}
        />
        <Select
          aria-label={t('status')}
          value={status}
          onChange={setStatus}
          options={[{ value: '', label: t('allStatuses') }, { value: 'ready', label: t('ready') }, { value: 'failed', label: t('failed') }]}
        />
        {imageListActions}
      </div>
    </Card>}
    <Card className="image-table-card" title={!showImageFilters ? t('offlineImage') : undefined} extra={!showImageFilters ? imageListActions : undefined}>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filteredImages}
        pagination={false}
        scroll={{ x: 1100 }}
        locale={{ emptyText: imageEmpty }}
        columns={[
          {
            title: t('offlineImage'),
            dataIndex: 'name',
            width: 245,
            render: (_: string, item: ImageArtifact) => <div className="image-name-cell"><span className="image-file-icon"><FileZipOutlined /></span><div><Button type="link" onClick={() => setSelectedImage(item)}>{item.name}</Button><Typography.Text type="secondary" ellipsis={{ tooltip: item.filename }}>{item.filename}</Typography.Text></div></div>,
          },
          {
            title: t('imageReferences'),
            dataIndex: 'imageRefs',
            render: (values: string[]) => <Space wrap size={[4, 4]}>{values?.slice(0, 2).map((value) => <Tag key={value}>{value}</Tag>)}{values?.length > 2 && <Tag>+{values.length - 2}</Tag>}</Space>,
          },
          {
            title: t('compatibility'),
            width: 155,
            render: (_: unknown, item: ImageArtifact) => <Space wrap size={[4, 4]}>{item.architectures?.length ? item.architectures.map((value) => <Tag key={value}>{value}</Tag>) : <Tag>{t('unknown')}</Tag>}<Tag>{item.format.toUpperCase()}</Tag></Space>,
          },
          {
            title: t('size'),
            dataIndex: 'sizeBytes',
            width: 90,
            render: bytes,
          },
          {
            title: t('uploadedAt'),
            dataIndex: 'createdAt',
            width: 145,
            render: (value: string) => formatDateTime(value, i18n.language, timezone),
          },
          {
            title: t('status'),
            dataIndex: 'status',
            width: 138,
            render: (value: string, item: ImageArtifact) => {
              const matchCount = matchingVersions(item, templates).length
              return <div className="image-status-cell"><StatusTag value={value} /><Typography.Text type="secondary">{matchCount ? t('catalogVersionMatchCount', { count: matchCount }) : t('noCatalogMatchShort')}</Typography.Text></div>
            },
          },
          {
            title: '',
            width: 88,
            render: (_: unknown, item: ImageArtifact) => <Space size={2} className="image-row-actions"><Button type="text" onClick={() => setSelectedImage(item)}>{t('details')}</Button>{canOperate && <Popconfirm title={t('deleteOfflineImage')} description={t('imageDeleteConfirm')} disabled={item.usedByCount > 0} onConfirm={() => void removeImage(item)}><Button danger type="text" disabled={item.usedByCount > 0} aria-label={`${t('delete')} ${item.name}`} title={item.usedByCount > 0 ? t('imageUsedByInstances', { count: item.usedByCount }) : t('delete')} icon={<DeleteOutlined />} /></Popconfirm>}</Space>,
          },
        ]}
      />
    </Card>
  </>

  const registryTab = <Card
    className="registry-section-card"
    title={t('registries')}
    loading={loading}
    extra={canOperate ? <Button type="primary" icon={<PlusOutlined />} onClick={() => showRegistry()}>{t('addRegistry')}</Button> : undefined}
  >
    <Alert className="registry-controller-note" type="info" showIcon message={t('registryTestFromController')} description={t('registryTestFromControllerHint')} />
    <Row gutter={[16, 16]} className="registry-grid">
      {registries.map((item) => {
        return <Col xs={24} lg={12} xl={8} key={item.id}>
          <Card className="registry-card">
            <div className="registry-card-header">
              <span className="registry-icon"><CloudServerOutlined /></span>
              <div><Typography.Title level={4}>{item.name}</Typography.Title><StatusTag value={item.status || 'unknown'} /></div>
            </div>
            <Typography.Text className="registry-url" copyable ellipsis={{ tooltip: item.url }}>{item.url}</Typography.Text>
            <div className="registry-facts">
              <div><Typography.Text type="secondary">{t('authentication')}</Typography.Text><Typography.Text>{item.hasPassword ? item.username || t('credentialsConfigured') : t('anonymousAccess')}</Typography.Text></div>
              <div><Typography.Text type="secondary">{t('lastTested')}</Typography.Text><Typography.Text>{formatDateTime(item.lastTestedAt, i18n.language, timezone)}</Typography.Text></div>
            </div>
            <Space wrap size={[6, 6]} className="registry-security-tags">
              {item.hasPassword && <Tag icon={<SafetyCertificateOutlined />}>{t('credentials')}</Tag>}
              {item.hasCaCertificate && <Tag color="cyan">{t('customCA')}</Tag>}
              {!item.hasPassword && !item.hasCaCertificate && <Tag>{t('standardTLS')}</Tag>}
            </Space>
            {item.statusMessage && <Alert className="registry-test-result" type={item.status === 'online' ? 'success' : item.status === 'offline' ? 'error' : 'warning'} showIcon message={t(item.statusMessage)} description={item.statusCode ? `HTTP ${item.statusCode}` : undefined} />}
            {canOperate && <div className="registry-card-footer">
              <Button icon={<CheckCircleOutlined />} loading={testingRegistry === item.id} onClick={() => void testRegistry(item)}>{t('testRegistry')}</Button>
              <Space size={4}>
                <Button type="text" icon={<EditOutlined />} onClick={() => showRegistry(item)}>{t('edit')}</Button>
                <Popconfirm title={t('deleteRegistry')} description={t('registryDeleteConfirm')} onConfirm={() => void removeRegistry(item)}><Button danger type="text" aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} /></Popconfirm>
              </Space>
            </div>}
          </Card>
        </Col>
      })}
      {registries.length === 0 && <Col span={24}><EmptyState description={t('registriesEmptyDescription')} /></Col>}
    </Row>
  </Card>

  return <>
    <PageHeader
      title={t('images')}
      description={t('imagesDescription')}
    />
    {pageError && <Alert className="ops-alert" type="warning" showIcon message={t('imagesLoadFailed')} description={pageError} action={<Button size="small" onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    <Tabs activeKey={activeTab} onChange={changeTab} items={[
      { key: 'images', label: <span className="tab-count">{t('offlineImages')}<span>{images.length}</span></span>, children: imageTab },
      { key: 'registries', label: <span className="tab-count">{t('registries')}<span>{registries.length}</span></span>, children: registryTab },
    ]} />

    <Modal
      title={t('uploadImage')}
      open={imageOpen}
      onCancel={closeImageUpload}
      width={680}
      style={{ top: 32 }}
      styles={{ body: { maxHeight: 'calc(100vh - 160px)', overflowY: 'auto', paddingRight: 4 } }}
      footer={<div className="workflow-modal-footer"><Button danger={uploading} onClick={closeImageUpload}>{uploading ? t('pauseUpload') : t('cancel')}</Button><Space>{file && progress > 0 && !uploading && <Button onClick={() => void discardUpload()}>{t('discardUpload')}</Button>}<Button type="primary" loading={uploading} disabled={!file || uploading || fileTooLarge} icon={<CloudUploadOutlined />} onClick={() => void upload()}>{progress > 0 ? t('continueUpload') : t('uploadImage')}</Button></Space></div>}
    >
      <Typography.Paragraph type="secondary" className="image-upload-intro">{t('imageUploadHint')}</Typography.Paragraph>
      <Upload.Dragger
        accept=".tar,.tar.gz,.tgz"
        maxCount={1}
        beforeUpload={() => false}
        fileList={file ? [file] : []}
        disabled={uploading}
        onChange={({ fileList }) => changeFile(fileList.at(-1) ?? null)}
      >
        <p className="ant-upload-drag-icon"><CloudUploadOutlined /></p>
        <p>{t('dropImageArchive')}</p>
        <p className="ant-upload-hint">{t('imageArchiveFormats')}</p>
      </Upload.Dragger>
      <Form form={uploadForm} layout="vertical" requiredMark={false} className="image-upload-form" onValuesChange={() => setUploadDraftDirty(true)}>
        <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input placeholder={t('imageDisplayNamePlaceholder')} disabled={uploading} /></Form.Item>
        <Form.Item name="expectedSha256" label={`${t('expectedChecksum')} (${t('optional')})`} extra={t('checksumHint')} rules={[{ pattern: /^[a-fA-F0-9]{64}$/, message: t('invalidChecksum') }]}><Input className="checksum-input" placeholder={t('checksumPlaceholder')} disabled={uploading} /></Form.Item>
      </Form>
      <Alert type="info" showIcon message={t('resumableUpload')} description={<Space direction="vertical" size={2}><span>{t('resumableUploadHint')}</span><span>{t('imageUploadPolicyHint', { max: bytes(uploadSettings.maxBytes), chunk: bytes(uploadSettings.chunkBytes) })}</span></Space>} />
      {(progress > 0 || uploadPhase === 'verifying') && <div className="image-upload-progress"><div><Typography.Text strong>{uploadPhase === 'verifying' ? t('verifyingImageArchive') : uploadPhase === 'resuming' ? t('resumingImageUpload') : uploadPhase === 'paused' ? t('imageUploadPaused') : t('uploadingImageChunks')}</Typography.Text><Typography.Text type="secondary">{uploadPhase === 'verifying' ? t('verifyingImageArchiveHint') : t('imageUploadProgressHint')}</Typography.Text></div><Progress percent={progress} status={uploadError ? 'exception' : uploadPhase === 'verifying' ? 'active' : undefined} /></div>}
      {uploadError && <Alert className="image-upload-error" type="error" showIcon message={t('imageUploadFailed')} description={uploadError} action={file && progress > 0 ? <Button size="small" onClick={() => void discardUpload()}>{t('discardUpload')}</Button> : undefined} />}
    </Modal>

    <Modal
      title={editingRegistry ? t('editRegistry') : t('addRegistry')}
      open={registryOpen}
      onCancel={closeRegistry}
      onOk={() => void saveRegistry()}
      confirmLoading={savingRegistry}
      okText={t('save')}
      cancelButtonProps={{ disabled: savingRegistry }}
      width={620}
      style={{ top: 32 }}
      styles={{ body: { maxHeight: 'calc(100vh - 160px)', overflowY: 'auto', paddingRight: 4 } }}
    >
      <Typography.Paragraph type="secondary" className="registry-form-intro">{t('registryFormDescription')}</Typography.Paragraph>
      <Form form={registryForm} layout="vertical" requiredMark={false} autoComplete="off" onValuesChange={() => setRegistryDraftDirty(true)}>
        <div className="form-grid">
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input autoFocus aria-label={t('name')} /></Form.Item>
          <Form.Item name="url" label={t('registryURL')} rules={[{ required: true }, { validator: (_, value?: string) => !value || isRegistryURL(value) ? Promise.resolve() : Promise.reject(new Error(t('invalidRegistryURL'))) }]}><Input aria-label={t('registryURL')} type="url" placeholder={t('registryURLPlaceholder')} /></Form.Item>
        </div>
        <div className="form-grid">
          <Form.Item name="username" label={t('username')}><Input aria-label={t('username')} autoComplete="off" data-1p-ignore data-lpignore="true" /></Form.Item>
          <div className="registry-secret-field"><Form.Item name="password" label={t('password')} extra={editingRegistry?.hasPassword ? t('registryPasswordKeepHint') : t('registryPasswordHint')}><Input.Password aria-label={t('password')} autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>{editingRegistry?.hasPassword && <Form.Item name="clearPassword" valuePropName="checked"><Checkbox onChange={(event) => { if (event.target.checked) registryForm.setFieldValue('password', '') }}>{t('removeRegistryPassword')}</Checkbox></Form.Item>}</div>
        </div>
        <Form.Item name="caCertificate" label={t('selfSignedCA')} extra={editingRegistry?.hasCaCertificate ? t('registryCAKeepHint') : t('registryCAHint')}><Input.TextArea aria-label={t('selfSignedCA')} rows={5} placeholder={t('certificatePlaceholder')} /></Form.Item>
        {editingRegistry?.hasCaCertificate && <Form.Item name="clearCaCertificate" valuePropName="checked"><Checkbox onChange={(event) => { if (event.target.checked) registryForm.setFieldValue('caCertificate', '') }}>{t('removeRegistryCA')}</Checkbox></Form.Item>}
      </Form>
    </Modal>

    <Modal
      title={t('unusedImageCleanup')}
      open={cleanupOpen}
      onCancel={() => { cleanupScanRequest.current += 1; setScanningCleanup(false); setCleanupOpen(false) }}
      onOk={() => void cleanupUnusedImages()}
      okText={t('cleanupSelectedImages')}
      okButtonProps={{ danger: true, disabled: scanningCleanup || !selectedCleanupIDs.length }}
      confirmLoading={cleaningImages}
      cancelButtonProps={{ disabled: cleaningImages }}
      width={760}
      styles={{ body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto' } }}
    >
      <Alert type="warning" showIcon message={t('unusedImageCleanupWarning')} description={t('unusedImageCleanupHint')} />
      <div className="image-cleanup-controls">
        <Typography.Text strong>{t('unusedForAtLeast')}</Typography.Text>
        <Select
          aria-label={t('unusedForAtLeast')}
          value={cleanupDays}
          onChange={(value) => { setCleanupDays(value); setCleanupPreview(null); setSelectedCleanupIDs([]); void scanUnusedImages(value) }}
          options={[7, 30, 90, 180, 365].map((value) => ({ value, label: t('dayCount', { count: value }) }))}
        />
        <Button icon={<ReloadOutlined />} loading={scanningCleanup} onClick={() => void scanUnusedImages()}>{t('scanAgain')}</Button>
      </div>
      {cleanupPreview && <Alert
        className="image-cleanup-summary"
        type={cleanupPreview.items.length ? 'info' : 'success'}
        showIcon
        message={cleanupPreview.items.length ? t('unusedImageScanResult', { count: cleanupPreview.items.length, size: bytes(cleanupPreview.totalBytes) }) : t('noUnusedImages')}
        description={cleanupPreview.items.length ? t('unusedImageSelectionSummary', { count: selectedCleanupItems.length, size: bytes(selectedCleanupBytes) }) : t('noUnusedImagesHint')}
      />}
      <Table
        className="image-cleanup-table"
        size="small"
        rowKey="id"
        loading={scanningCleanup}
        dataSource={cleanupPreview?.items ?? []}
        pagination={false}
        locale={{ emptyText: cleanupPreview ? t('noUnusedImages') : t('scanningUnusedImages') }}
        rowSelection={{ selectedRowKeys: selectedCleanupIDs, onChange: (keys) => setSelectedCleanupIDs(keys.slice(0, 200).map(String)) }}
        columns={[
          { title: t('offlineImage'), dataIndex: 'name', render: (value: string, item: ImageArtifact) => <div><Typography.Text strong>{value}</Typography.Text><br /><Typography.Text type="secondary">{item.filename}</Typography.Text></div> },
          { title: t('lastActivity'), width: 190, render: (_: unknown, item: ImageArtifact) => formatDateTime(item.lastUsedAt ?? item.createdAt, i18n.language, timezone) },
          { title: t('size'), dataIndex: 'sizeBytes', width: 110, render: bytes },
        ]}
      />
    </Modal>

    <Drawer
      title={selectedImage ? <Space><FileZipOutlined />{selectedImage.name}</Space> : t('imageDetails')}
      open={!!selectedImage}
      onClose={() => setSelectedImage(null)}
      width={620}
      footer={canOperate && selectedImage ? <div className="workflow-drawer-footer"><Typography.Text type="secondary">{selectedImage.usedByCount > 0 ? t('imageUsedByInstances', { count: selectedImage.usedByCount }) : t('imageDeleteAvailableHint')}</Typography.Text><Space>{primaryMatch ? <Button type="primary" icon={<RocketOutlined />} onClick={createWithSelectedImage}>{selectedCompatibleHosts.length ? t('createInstance') : t('connectHostAndContinue')}</Button> : <Button onClick={() => navigate('/catalog')}>{t('catalog')}</Button>}<Popconfirm title={t('deleteOfflineImage')} description={t('imageDeleteConfirm')} disabled={selectedImage.usedByCount > 0} onConfirm={() => void removeImage(selectedImage)}><Button danger icon={<DeleteOutlined />} disabled={selectedImage.usedByCount > 0}>{t('delete')}</Button></Popconfirm></Space></div> : undefined}
    >
      {selectedImage && <div className="image-detail">
        <div className="image-detail-summary"><span><CheckCircleOutlined /></span><div><Space wrap><StatusTag value={selectedImage.status} />{selectedImage.architectures.map((value) => <Tag key={value}>{value}</Tag>)}{selectedImage.usedByCount > 0 && <Tag color="blue">{t('imageUsedByInstances', { count: selectedImage.usedByCount })}</Tag>}</Space><Typography.Title level={4}>{t('imageReadyForDeployment')}</Typography.Title><Typography.Paragraph type="secondary">{t('imageReadyForDeploymentHint')}</Typography.Paragraph></div></div>
        <Card size="small" title={t('deploymentReadiness')}>
          {selectedMatches.length ? <div className="image-readiness"><Alert type={selectedCompatibleHosts.length ? 'success' : 'warning'} showIcon message={t('imageMatchesCatalog')} description={selectedCompatibleHosts.length ? t('imageCompatibleHostCount', { versions: selectedMatches.length, hosts: selectedCompatibleHosts.length }) : t('imageNeedsCompatibleHost')} /><div><Typography.Text type="secondary">{t('matchingCatalogVersions')}</Typography.Text><Space wrap size={[6, 6]}>{selectedMatches.map(({ template, version }) => <Tag key={version.id}>{template.name} {version.version}</Tag>)}</Space></div></div> : <Alert type="warning" showIcon message={t('imageHasNoCatalogMatch')} description={t('imageHasNoCatalogMatchHint')} />}
        </Card>
        <Card size="small" title={t('imageReferences')}><Space wrap>{selectedImage.imageRefs.length ? selectedImage.imageRefs.map((value) => <Tag key={value}>{value}</Tag>) : <Typography.Text type="secondary">{t('noImageReferences')}</Typography.Text>}</Space></Card>
        <Card size="small" title={t('metadata')}><Descriptions column={1} size="small" items={[
          { key: 'filename', label: t('filename'), children: selectedImage.filename },
          { key: 'format', label: t('format'), children: selectedImage.format.toUpperCase() },
          { key: 'size', label: t('size'), children: bytes(selectedImage.sizeBytes) },
          { key: 'uploaded', label: t('uploadedAt'), children: formatDateTime(selectedImage.createdAt, i18n.language, timezone) },
          { key: 'used', label: t('lastUsed'), children: selectedImage.lastUsedAt ? formatDateTime(selectedImage.lastUsedAt, i18n.language, timezone) : t('neverUsed') },
        ]} /></Card>
        <Card size="small" title={t('sha256')}><Typography.Text className="image-checksum" code copyable>{selectedImage.sha256}</Typography.Text></Card>
      </div>}
    </Drawer>
  </>
}
