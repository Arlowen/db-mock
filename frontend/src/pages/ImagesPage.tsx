import {
  CheckCircleOutlined,
  CloudServerOutlined,
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  FileZipOutlined,
  PlusOutlined,
  ReloadOutlined,
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
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { api, errorMessage, uploadInChunks } from '../lib/api'
import { formatDateTime } from '../lib/localization'
import type { ImageArtifact, Registry } from '../lib/types'
import { bytes } from '../lib/types'

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

function archiveName(filename: string): string {
  return filename.replace(/\.(?:tar\.gz|tgz|tar)$/i, '')
}

export function ImagesPage() {
  const { t, i18n } = useTranslation()
  const { message } = App.useApp()
  const [images, setImages] = useState<ImageArtifact[]>([])
  const [registries, setRegistries] = useState<Registry[]>([])
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState('')
  const [activeTab, setActiveTab] = useState('images')
  const [search, setSearch] = useState('')
  const [architecture, setArchitecture] = useState('')
  const [status, setStatus] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [savingRegistry, setSavingRegistry] = useState(false)
  const [testingRegistry, setTestingRegistry] = useState('')
  const [imageOpen, setImageOpen] = useState(false)
  const [registryOpen, setRegistryOpen] = useState(false)
  const [selectedImage, setSelectedImage] = useState<ImageArtifact | null>(null)
  const [editingRegistry, setEditingRegistry] = useState<Registry | null>(null)
  const [registryResults, setRegistryResults] = useState<Record<string, RegistryTestResult>>({})
  const [file, setFile] = useState<UploadFile | null>(null)
  const [progress, setProgress] = useState(0)
  const [uploadForm] = Form.useForm<UploadValues>()
  const [registryForm] = Form.useForm<RegistryValues>()

  const load = useCallback(async () => {
    try {
      setPageError('')
      const [imageResponse, registryResponse] = await Promise.all([
        api<{ items: ImageArtifact[] }>('/images'),
        api<{ items: Registry[] }>('/registries'),
      ])
      setImages(imageResponse.items)
      setRegistries(registryResponse.items)
    } catch (error) {
      setPageError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

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

  const resetImageFilters = () => {
    setSearch('')
    setArchitecture('')
    setStatus('')
  }

  const showImageUpload = () => {
    setFile(null)
    setProgress(0)
    setUploadError('')
    uploadForm.resetFields()
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
    setRegistryOpen(true)
  }

  const changeFile = (nextFile: UploadFile | null) => {
    setFile(nextFile)
    setUploadError('')
    setProgress(0)
    if (nextFile && !uploadForm.getFieldValue('name')) uploadForm.setFieldValue('name', archiveName(nextFile.name))
  }

  const upload = async () => {
    if (!file?.originFileObj) return
    try {
      const values = await uploadForm.validateFields()
      setUploading(true)
      setUploadError('')
      await uploadInChunks(file.originFileObj, setProgress, values.expectedSha256?.trim().toLowerCase() ?? '', values.name.trim())
      message.success(t('imageUploadComplete'))
      setImageOpen(false)
      setFile(null)
      setProgress(0)
      uploadForm.resetFields()
      await load()
    } catch (error) {
      if (error instanceof Error) setUploadError(errorMessage(error))
    } finally {
      setUploading(false)
    }
  }

  const saveRegistry = async () => {
    try {
      setSavingRegistry(true)
      const values = await registryForm.validateFields()
      await api(editingRegistry ? `/registries/${editingRegistry.id}` : '/registries', {
        method: editingRegistry ? 'PUT' : 'POST',
        body: values,
      })
      message.success(t('saved'))
      if (editingRegistry) setRegistryResults((current) => {
        const next = { ...current }
        delete next[editingRegistry.id]
        return next
      })
      setRegistryOpen(false)
      setEditingRegistry(null)
      registryForm.resetFields()
      await load()
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
      setRegistryResults((current) => ({ ...current, [item.id]: result }))
      setRegistries((current) => current.map((registry) => registry.id === item.id ? { ...registry, status: result.status, lastTestedAt: result.checkedAt } : registry))
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
    : <EmptyState compact action={showImageUpload} actionLabel={t('uploadImage')} description={t('imagesEmptyDescription')} />

  const imageTab = <>
    <Card className="image-toolbar-card" size="small">
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
        <Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button>
      </div>
    </Card>
    <Card className="image-table-card">
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filteredImages}
        pagination={false}
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
            render: (value: string) => formatDateTime(value, i18n.language),
          },
          {
            title: t('status'),
            dataIndex: 'status',
            width: 90,
            render: (value: string) => <StatusTag value={value} />,
          },
          {
            title: '',
            width: 88,
            render: (_: unknown, item: ImageArtifact) => <Space size={2} className="image-row-actions"><Button type="text" onClick={() => setSelectedImage(item)}>{t('details')}</Button><Popconfirm title={t('deleteOfflineImage')} description={t('imageDeleteConfirm')} onConfirm={() => void removeImage(item)}><Button danger type="text" aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} /></Popconfirm></Space>,
          },
        ]}
      />
    </Card>
  </>

  const registryTab = <>
    <Alert className="registry-controller-note" type="info" showIcon message={t('registryTestFromController')} description={t('registryTestFromControllerHint')} />
    {loading ? <Card loading /> : <Row gutter={[16, 16]} className="registry-grid">
      {registries.map((item) => {
        const testResult = registryResults[item.id]
        return <Col xs={24} lg={12} xl={8} key={item.id}>
          <Card className="registry-card">
            <div className="registry-card-header">
              <span className="registry-icon"><CloudServerOutlined /></span>
              <div><Typography.Title level={4}>{item.name}</Typography.Title><StatusTag value={item.status || 'unknown'} /></div>
            </div>
            <Typography.Text className="registry-url" copyable ellipsis={{ tooltip: item.url }}>{item.url}</Typography.Text>
            <div className="registry-facts">
              <div><Typography.Text type="secondary">{t('authentication')}</Typography.Text><Typography.Text>{item.hasPassword ? item.username || t('credentialsConfigured') : t('anonymousAccess')}</Typography.Text></div>
              <div><Typography.Text type="secondary">{t('lastTested')}</Typography.Text><Typography.Text>{formatDateTime(item.lastTestedAt, i18n.language)}</Typography.Text></div>
            </div>
            <Space wrap size={[6, 6]} className="registry-security-tags">
              {item.hasPassword && <Tag icon={<SafetyCertificateOutlined />}>{t('credentials')}</Tag>}
              {item.hasCaCertificate && <Tag color="cyan">{t('customCA')}</Tag>}
              {!item.hasPassword && !item.hasCaCertificate && <Tag>{t('standardTLS')}</Tag>}
            </Space>
            {testResult && <Alert className="registry-test-result" type={testResult.status === 'online' ? 'success' : testResult.status === 'offline' ? 'error' : 'warning'} showIcon message={t(testResult.message)} description={testResult.statusCode ? `HTTP ${testResult.statusCode}` : undefined} />}
            <div className="registry-card-footer">
              <Button icon={<CheckCircleOutlined />} loading={testingRegistry === item.id} onClick={() => void testRegistry(item)}>{t('testRegistry')}</Button>
              <Space size={4}>
                <Button type="text" icon={<EditOutlined />} onClick={() => showRegistry(item)}>{t('edit')}</Button>
                <Popconfirm title={t('deleteRegistry')} description={t('registryDeleteConfirm')} onConfirm={() => void removeRegistry(item)}><Button danger type="text" aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} /></Popconfirm>
              </Space>
            </div>
          </Card>
        </Col>
      })}
      {registries.length === 0 && <Col span={24}><Card><EmptyState action={() => showRegistry()} actionLabel={t('addRegistry')} description={t('registriesEmptyDescription')} /></Card></Col>}
    </Row>}
  </>

  return <>
    <PageHeader
      title={t('images')}
      description={t('imagesDescription')}
      actions={<><Button icon={<PlusOutlined />} onClick={() => showRegistry()}>{t('addRegistry')}</Button><Button type="primary" icon={<CloudUploadOutlined />} onClick={showImageUpload}>{t('uploadImage')}</Button></>}
    />
    {pageError && <Alert className="ops-alert" type="warning" showIcon message={t('imagesLoadFailed')} description={pageError} action={<Button size="small" onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
      { key: 'images', label: <span className="tab-count">{t('offlineImages')}<span>{images.length}</span></span>, children: imageTab },
      { key: 'registries', label: <span className="tab-count">{t('registries')}<span>{registries.length}</span></span>, children: registryTab },
    ]} />

    <Modal
      title={t('uploadImage')}
      open={imageOpen}
      onCancel={() => { if (!uploading) setImageOpen(false) }}
      onOk={() => void upload()}
      confirmLoading={uploading}
      okText={uploading ? t('uploading') : t('uploadImage')}
      okButtonProps={{ disabled: !file }}
      cancelButtonProps={{ disabled: uploading }}
      width={680}
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
      <Form form={uploadForm} layout="vertical" requiredMark={false} className="image-upload-form">
        <Form.Item name="name" label={t('displayName')} rules={[{ required: true, whitespace: true }]}><Input placeholder={t('imageDisplayNamePlaceholder')} disabled={uploading} /></Form.Item>
        <Form.Item name="expectedSha256" label={`${t('expectedChecksum')} (${t('optional')})`} extra={t('checksumHint')} rules={[{ pattern: /^[a-fA-F0-9]{64}$/, message: t('invalidChecksum') }]}><Input className="checksum-input" placeholder={t('checksumPlaceholder')} disabled={uploading} /></Form.Item>
      </Form>
      <Alert type="info" showIcon message={t('resumableUpload')} description={t('resumableUploadHint')} />
      {progress > 0 && <Progress percent={progress} status={uploadError ? 'exception' : undefined} style={{ marginTop: 18 }} />}
      {uploadError && <Alert className="image-upload-error" type="error" showIcon message={t('imageUploadFailed')} description={uploadError} />}
    </Modal>

    <Modal
      title={editingRegistry ? t('editRegistry') : t('addRegistry')}
      open={registryOpen}
      onCancel={() => { if (!savingRegistry) setRegistryOpen(false) }}
      onOk={() => void saveRegistry()}
      confirmLoading={savingRegistry}
      okText={t('save')}
      cancelButtonProps={{ disabled: savingRegistry }}
      width={620}
    >
      <Typography.Paragraph type="secondary" className="registry-form-intro">{t('registryFormDescription')}</Typography.Paragraph>
      <Form form={registryForm} layout="vertical" requiredMark={false} autoComplete="off">
        <div className="form-grid">
          <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
          <Form.Item name="url" label={t('registryURL')} rules={[{ required: true }, { type: 'url' }]}><Input type="url" placeholder={t('registryURLPlaceholder')} /></Form.Item>
        </div>
        <div className="form-grid">
          <Form.Item name="username" label={t('username')}><Input autoComplete="off" data-1p-ignore data-lpignore="true" /></Form.Item>
          <div className="registry-secret-field"><Form.Item name="password" label={t('password')} extra={editingRegistry?.hasPassword ? t('registryPasswordKeepHint') : t('registryPasswordHint')}><Input.Password autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>{editingRegistry?.hasPassword && <Form.Item name="clearPassword" valuePropName="checked"><Checkbox onChange={(event) => { if (event.target.checked) registryForm.setFieldValue('password', '') }}>{t('removeRegistryPassword')}</Checkbox></Form.Item>}</div>
        </div>
        <Form.Item name="caCertificate" label={t('selfSignedCA')} extra={editingRegistry?.hasCaCertificate ? t('registryCAKeepHint') : t('registryCAHint')}><Input.TextArea rows={5} placeholder={t('certificatePlaceholder')} /></Form.Item>
        {editingRegistry?.hasCaCertificate && <Form.Item name="clearCaCertificate" valuePropName="checked"><Checkbox onChange={(event) => { if (event.target.checked) registryForm.setFieldValue('caCertificate', '') }}>{t('removeRegistryCA')}</Checkbox></Form.Item>}
      </Form>
    </Modal>

    <Drawer
      title={selectedImage ? <Space><FileZipOutlined />{selectedImage.name}</Space> : t('imageDetails')}
      open={!!selectedImage}
      onClose={() => setSelectedImage(null)}
      width={620}
      footer={selectedImage && <div className="workflow-drawer-footer"><Typography.Text type="secondary">{t('imageDeleteBlockedHint')}</Typography.Text><Popconfirm title={t('deleteOfflineImage')} description={t('imageDeleteConfirm')} onConfirm={() => void removeImage(selectedImage)}><Button danger icon={<DeleteOutlined />}>{t('delete')}</Button></Popconfirm></div>}
    >
      {selectedImage && <div className="image-detail">
        <div className="image-detail-summary"><span><CheckCircleOutlined /></span><div><Space><StatusTag value={selectedImage.status} />{selectedImage.architectures.map((value) => <Tag key={value}>{value}</Tag>)}</Space><Typography.Title level={4}>{t('imageReadyForDeployment')}</Typography.Title><Typography.Paragraph type="secondary">{t('imageReadyForDeploymentHint')}</Typography.Paragraph></div></div>
        <Card size="small" title={t('imageReferences')}><Space wrap>{selectedImage.imageRefs.length ? selectedImage.imageRefs.map((value) => <Tag key={value}>{value}</Tag>) : <Typography.Text type="secondary">{t('noImageReferences')}</Typography.Text>}</Space></Card>
        <Card size="small" title={t('metadata')}><Descriptions column={1} size="small" items={[
          { key: 'filename', label: t('filename'), children: selectedImage.filename },
          { key: 'format', label: t('format'), children: selectedImage.format.toUpperCase() },
          { key: 'size', label: t('size'), children: bytes(selectedImage.sizeBytes) },
          { key: 'uploaded', label: t('uploadedAt'), children: formatDateTime(selectedImage.createdAt, i18n.language) },
          { key: 'used', label: t('lastUsed'), children: selectedImage.lastUsedAt ? formatDateTime(selectedImage.lastUsedAt, i18n.language) : t('neverUsed') },
        ]} /></Card>
        <Card size="small" title={t('sha256')}><Typography.Text className="image-checksum" code copyable>{selectedImage.sha256}</Typography.Text></Card>
      </div>}
    </Drawer>
  </>
}
