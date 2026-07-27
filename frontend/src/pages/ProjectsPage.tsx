import { CloudServerOutlined, DatabaseOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined, RocketOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Col, ColorPicker, Form, Grid, Input, Modal, Popconfirm, Row, Select, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { hasProjectDeploymentDefaults, labelText, parseLabelText } from '../lib/project-deployment-defaults'
import type { Project } from '../lib/types'

interface ProjectForm {
  name: string
  description?: string
  color: string
  defaultEnvironment?: string
  defaultExpiryDays?: number
  defaultLabels?: string
}

function projectDraftChanged(values: ProjectForm, baseline: ProjectForm | null) {
  if (!baseline) return true
  return values.name !== baseline.name
    || (values.description || '') !== (baseline.description || '')
    || values.color !== baseline.color
    || (values.defaultEnvironment || '') !== (baseline.defaultEnvironment || '')
    || values.defaultExpiryDays !== baseline.defaultExpiryDays
    || (values.defaultLabels || '') !== (baseline.defaultLabels || '')
}

export function ProjectsPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { message, modal } = App.useApp()
  const navigate = useNavigate()
  const screens = Grid.useBreakpoint()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const [items, setItems] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState('')
  const [draftDirty, setDraftDirty] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [search, setSearch] = useState('')
  const [form] = Form.useForm<ProjectForm>()
  const draftBaseline = useRef<ProjectForm | null>(null)
  const projectName = Form.useWatch('name', form)
  const filteredItems = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return needle
      ? items.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(needle))
      : items
  }, [items, search])

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const response = await api<{ items: Project[] }>('/projects')
      setItems(response.items)
      setLoadError('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const show = (item?: Project) => {
    const values: ProjectForm = item
      ? {
          name: item.name,
          description: item.description,
          color: item.color,
          defaultEnvironment: item.defaultEnvironment,
          defaultExpiryDays: item.defaultExpiryDays,
          defaultLabels: labelText(item.defaultLabels),
        }
      : { name: '', description: '', color: '#2563eb', defaultEnvironment: undefined, defaultExpiryDays: undefined, defaultLabels: '' }
    form.resetFields()
    setEditing(item ?? null)
    setSaveError('')
    setDraftDirty(false)
    draftBaseline.current = values
    form.setFieldsValue(values)
    setOpen(true)
  }

  const finishCloseEditor = () => {
    setOpen(false)
    setEditing(null)
    setSaveError('')
    setDraftDirty(false)
    draftBaseline.current = null
    form.resetFields()
  }

  const closeEditor = () => {
    if (saving) return
    if (!draftDirty) {
      finishCloseEditor()
      return
    }
    modal.confirm({
      title: t('discardProjectDraftTitle'),
      content: t('discardProjectDraftHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseEditor,
    })
  }

  const submit = async () => {
    try {
      setSaveError('')
      setSaving(true)
      const values = await form.validateFields()
      const defaultLabels = parseLabelText(values.defaultLabels) || {}
      await api(editing ? `/projects/${editing.id}` : '/projects', {
        method: editing ? 'PUT' : 'POST',
        body: {
          name: values.name.trim(),
          description: values.description?.trim() || '',
          color: values.color,
          defaultEnvironment: values.defaultEnvironment || null,
          defaultExpiryDays: values.defaultExpiryDays ?? null,
          defaultLabels,
        },
      })
      message.success(t('saved'))
      finishCloseEditor()
      await load()
    } catch (error) {
      if (error instanceof Error) setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (item: Project) => {
    try {
      setDeleting(item.id)
      await api(`/projects/${item.id}`, { method: 'DELETE' })
      message.success(t('deleted'))
      await load()
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setDeleting('')
    }
  }

  const projectCard = (item: Project) => {
    const deleteBlocked = item.hostCount + item.instanceCount > 0
    const defaultLabelCount = Object.keys(item.defaultLabels || {}).length
    const hasDeploymentDefaults = hasProjectDeploymentDefaults(item)
    return <Col xs={24} md={12} xl={8} key={item.id}>
      <Card
        className="project-card"
        style={{ borderTopColor: item.color }}
        actions={canOperate ? [
          <Button key="create-database" type="text" icon={<RocketOutlined />} onClick={() => navigate(`/instances?create=1&project=${item.id}`)}>{t('createInstance')}</Button>,
          <Button key="edit" type="text" icon={<EditOutlined />} onClick={() => show(item)}>{t('edit')}</Button>,
          <span key="delete" title={deleteBlocked ? t('projectDeleteBlockedHint') : t('delete')}>
            <Popconfirm
              title={t('deleteProjectConfirm', { name: item.name })}
              description={t('deleteProjectHint')}
              disabled={deleteBlocked}
              okText={t('delete')}
              cancelText={t('cancel')}
              okButtonProps={{ danger: true, loading: deleting === item.id }}
              onConfirm={() => void remove(item)}
            >
              <Button type="text" danger disabled={deleteBlocked} loading={deleting === item.id} icon={<DeleteOutlined />}>{t('delete')}</Button>
            </Popconfirm>
          </span>,
        ] : undefined}
      >
        <div className="project-card-heading">
          <span className="project-dot" style={{ background: item.color }} />
          <Typography.Title level={4} ellipsis={{ tooltip: item.name }}>{item.name}</Typography.Title>
        </div>
        <Typography.Paragraph className="project-card-description" type="secondary" ellipsis={{ rows: 2, tooltip: item.description || undefined }}>
          {item.description || t('noDescription')}
        </Typography.Paragraph>
        <div className="project-deployment-defaults">
          <div>
            <Typography.Text strong>{t('deploymentDefaults')}</Typography.Text>
            <Typography.Text type="secondary">{t(hasDeploymentDefaults ? 'projectDefaultsActive' : 'projectUsesPlatformDefaults')}</Typography.Text>
          </div>
          <Space size={[4, 4]} wrap>
            <Tag>{translateCode(t, item.defaultEnvironment || 'development')}</Tag>
            <Tag>{item.defaultExpiryDays === 0 ? t('retainIndefinitely') : t('daysCount', { count: item.defaultExpiryDays ?? 7 })}</Tag>
            {defaultLabelCount > 0 && <Tag>{t('defaultLabelCount', { count: defaultLabelCount })}</Tag>}
          </Space>
        </div>
        <div className="project-resource-stats">
          <button type="button" onClick={() => navigate(`/hosts?project=${item.id}`)}>
            <CloudServerOutlined />
            <span><strong>{item.hostCount}</strong>{t('hosts')}</span>
          </button>
          <button type="button" onClick={() => navigate(`/instances?project=${item.id}`)}>
            <DatabaseOutlined />
            <span><strong>{item.instanceCount}</strong>{t('instances')}</span>
          </button>
        </div>
        <Typography.Text className="project-updated-at" type="secondary">
          {t('lastUpdated')} · {formatDateTime(item.updatedAt || item.createdAt, i18n.language, timezone)}
        </Typography.Text>
      </Card>
    </Col>
  }

  const filtersActive = !!search.trim()
  const listActions = <Space wrap>
    <Button loading={loading} icon={<ReloadOutlined />} onClick={() => void load(true)}>{t('refresh')}</Button>
    {canOperate && <Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('createProject')}</Button>}
  </Space>

  return <>
    <PageHeader title={t('projects')} description={t('projectsDescription')} />
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('projectListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => void load(true)}>{t('retry')}</Button>} />}
    {(items.length > 0 || !loadError) && <Card className="project-list-card" loading={loading && items.length === 0} title={t('projects')} extra={items.length ? listActions : undefined}>
      {items.length === 0
        ? <EmptyState action={canOperate ? () => show() : undefined} actionLabel={canOperate ? t('createProject') : undefined} description={t('projectsEmptyDescription')} />
        : <>
          <div className="project-toolbar">
            <Input
              allowClear
              className="project-search"
              aria-label={t('projectSearchLabel')}
              placeholder={t('projectSearchPlaceholder')}
              prefix={<SearchOutlined />}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Typography.Text type="secondary" aria-live="polite">
              {t(filtersActive ? 'projectFilteredResultCount' : 'projectResultCount', { filtered: filteredItems.length, total: items.length, count: items.length })}
            </Typography.Text>
          </div>
          {filteredItems.length
            ? <Row className="project-grid" gutter={[16, 16]}>{filteredItems.map(projectCard)}</Row>
            : <EmptyState compact action={() => setSearch('')} actionLabel={t('clearFilters')} description={t('projectFilteredEmptyDescription')} />}
        </>}
    </Card>}

    <Modal
      className="project-editor-modal"
      title={editing ? t('editProject') : t('createProject')}
      open={open}
      onCancel={closeEditor}
      onOk={() => void submit()}
      confirmLoading={saving}
      closable={!saving}
      maskClosable={!saving}
      cancelButtonProps={{ disabled: saving }}
      okButtonProps={{ disabled: !projectName?.trim() || (!!editing && !draftDirty) }}
      okText={t('save')}
      width={640}
      style={{ top: screens.md === false ? 12 : 32 }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        autoComplete="off"
        onValuesChange={(_, values) => {
          setSaveError('')
          setDraftDirty(projectDraftChanged(values, draftBaseline.current))
        }}
      >
        <Alert className="form-save-alert" type="info" showIcon message={t('projectFormHint')} />
        {saveError && <Alert className="form-save-alert" type="error" showIcon message={t('projectSaveFailed')} description={saveError} />}
        <Form.Item
          name="name"
          label={t('name')}
          extra={t('projectNameHint')}
          rules={[
            { required: true, whitespace: true, message: t('projectNameRequired') },
            { max: 120, message: t('projectNameLength') },
          ]}
        >
          <Input autoFocus maxLength={120} />
        </Form.Item>
        <Form.Item name="description" label={t('description')} rules={[{ max: 500, message: t('projectDescriptionLength') }]}>
          <Input.TextArea rows={3} maxLength={500} showCount />
        </Form.Item>
        <Form.Item name="color" label={t('color')} extra={t('projectColorHint')} getValueFromEvent={(_, hex: string) => hex}>
          <ColorPicker format="hex" showText={(color) => color.toHexString()} />
        </Form.Item>
        <Card size="small" className="project-defaults-editor" title={t('deploymentDefaults')}>
          <Typography.Paragraph type="secondary">{t('projectDeploymentDefaultsHint')}</Typography.Paragraph>
          <div className="form-grid">
            <Form.Item name="defaultEnvironment" label={t('defaultEnvironment')} extra={t('defaultEnvironmentHint')}>
              <Select allowClear placeholder={t('usePlatformDefault')} options={['development', 'testing', 'staging', 'production'].map((value) => ({ value, label: translateCode(t, value) }))} />
            </Form.Item>
            <Form.Item name="defaultExpiryDays" label={t('defaultUsePeriod')} extra={t('defaultUsePeriodHint')}>
              <Select allowClear placeholder={t('usePlatformDefault')} options={[1, 3, 7, 14, 30].map((days) => ({ value: days, label: t('daysCount', { count: days }) })).concat([{ value: 0, label: t('retainIndefinitely') }])} />
            </Form.Item>
          </div>
          <Form.Item
            name="defaultLabels"
            label={t('defaultLabels')}
            extra={t('defaultLabelsHint')}
            rules={[{ validator: (_, value?: string) => parseLabelText(value) ? Promise.resolve() : Promise.reject(new Error(t('invalidLabels'))) }]}
          >
            <Input placeholder={t('labelsPlaceholder')} />
          </Form.Item>
        </Card>
      </Form>
    </Modal>
  </>
}
