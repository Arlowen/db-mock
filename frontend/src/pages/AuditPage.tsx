import { ArrowRightOutlined, ClearOutlined, DownloadOutlined, EyeOutlined, FileSearchOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, DatePicker, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { auditChangeEntries, auditResourcePath, auditValueText, isRedactedAuditValue } from '../lib/audit'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import { bytes, type Audit } from '../lib/types'

export function AuditPage() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { canManageSettings } = permissionsFor(user!)
  const { timezone } = useSystemSettings()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [items, setItems] = useState<Audit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [resourceType, setResourceType] = useState('')
  const [selected, setSelected] = useState<Audit | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearError, setClearError] = useState('')
  const [before, setBefore] = useState<Dayjs | null>(dayjs().subtract(30, 'day'))
  const [confirm, setConfirm] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams()
      if (deferredSearch) query.set('search', deferredSearch)
      if (resourceType) query.set('resourceType', resourceType)
      const value = await api<{ items: Audit[] }>(`/audit?${query.toString()}`)
      setItems(value.items)
      setLoadError('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [deferredSearch, resourceType])
  useEffect(() => { setLoading(true); void load() }, [load])

  const clear = async () => {
    if (!before || before.isAfter(dayjs()) || confirm !== 'CLEAR') return
    try {
      setClearing(true)
      setClearError('')
      const result = await api<{ deleted: number }>('/audit/clear', { method: 'POST', body: { before: before.toISOString(), confirm } })
      message.success(t('deletedRecords', { count: result.deleted }))
      setClearOpen(false)
      setConfirm('')
      await load()
    } catch (error) {
      setClearError(errorMessage(error))
    } finally {
      setClearing(false)
    }
  }
  const showClear = () => { setBefore(dayjs().subtract(30, 'day')); setConfirm(''); setClearError(''); setClearOpen(true) }
  const closeClear = () => {
    if (clearing) return
    setClearOpen(false)
    setConfirm('')
    setClearError('')
  }
  const exportQuery = new URLSearchParams()
  if (deferredSearch) exportQuery.set('search', deferredSearch)
  if (resourceType) exportQuery.set('resourceType', resourceType)
  const exportURL = `/api/v1/audit/export?${exportQuery.toString()}`
  const hasFilters = !!(search || resourceType)
  const resetFilters = () => { setSearch(''); setResourceType(''); setPage(1) }
  const maxPage = Math.max(1, Math.ceil(items.length / pageSize))
  const clearCutoffValid = !!before && !before.isAfter(dayjs())
  useEffect(() => { if (page > maxPage) setPage(maxPage) }, [maxPage, page])
  const showList = !loadError || items.length > 0
  const resourcePath = selected ? auditResourcePath(selected) : ''
  const changes = useMemo(() => auditChangeEntries(selected?.changes), [selected])

  const changeValue = (key: string, value: unknown) => {
    if (isRedactedAuditValue(value)) return t('redacted')
    if (typeof value === 'boolean') return t(value ? 'yes' : 'no')
    if (key === 'freedBytes' && typeof value === 'number') return bytes(value)
    if (key === 'status' && typeof value === 'string') return translateCode(t, value)
    if (key === 'locale' && value === 'zh-CN') return t('languageChinese')
    if (key === 'locale' && value === 'en-US') return t('languageEnglish')
    return auditValueText(value)
  }
  const openPath = (path: string) => { setSelected(null); navigate(path) }

  const columns = [
    { title: t('time'), dataIndex: 'createdAt', width: 175, render: (value: string) => formatDateTime(value, i18n.language, timezone) },
    { title: t('user'), dataIndex: 'username', width: 130, render: (value: string) => value || '—' },
    { title: t('action'), width: 190, render: (_: unknown, item: Audit) => <Button className="audit-action-link" type="link" onClick={() => setSelected(item)}>{translateCode(t, item.action, 'auditAction')}</Button> },
    { title: t('resources'), width: 210, render: (_: unknown, item: Audit) => <div className="audit-resource-cell"><Tag>{translateCode(t, item.resourceType, 'resourceType')}</Tag><Typography.Text ellipsis={{ tooltip: item.resourceName }}>{item.resourceName || '—'}</Typography.Text></div> },
    { title: t('result'), dataIndex: 'result', width: 90, render: (value: string) => <Tag color={value === 'success' ? 'green' : 'red'}>{translateCode(t, value)}</Tag> },
    { title: t('ip'), dataIndex: 'ip', width: 135 },
    { title: t('message'), dataIndex: 'message', ellipsis: true, render: (value: string) => value ? t(value, { defaultValue: value }) : '—' },
    { title: '', width: 58, fixed: 'right' as const, render: (_: unknown, item: Audit) => <Button type="text" title={t('details')} aria-label={`${t('details')} ${translateCode(t, item.action, 'auditAction')}`} icon={<EyeOutlined />} onClick={() => setSelected(item)} /> },
  ]

  return <>
    <PageHeader title={t('audit')} description={t('auditDescription')} />
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('auditListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {showList && <Card className="audit-table-card">
      <div className="split-toolbar table-toolbar"><Space wrap><Input aria-label={t('search')} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} allowClear prefix={<SearchOutlined />} placeholder={t('search')} style={{ width: 260 }} /><Select aria-label={t('resource')} value={resourceType} onChange={(value) => { setResourceType(value); setPage(1) }} style={{ width: 170 }} options={[{ value: '', label: t('allResources') }, ...['platform', 'session', 'user', 'project', 'host', 'instance', 'task', 'image', 'image_upload', 'template', 'registry', 'webhook', 'alert', 'setting', 'audit'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Button icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button></Space><Space wrap><Button href={exportURL} icon={<DownloadOutlined />}>{t('export')}</Button>{canManageSettings && <Button danger icon={<ClearOutlined />} onClick={showClear}>{t('clear')}</Button>}</Space></div>
      <Table rowKey="id" loading={loading || search !== deferredSearch} dataSource={items} columns={columns} scroll={{ x: 1250 }} pagination={{ current: page, pageSize, showSizeChanger: true, pageSizeOptions: [20, 50, 100], onChange: (nextPage, nextPageSize) => { setPage(nextPageSize === pageSize ? nextPage : 1); setPageSize(nextPageSize) } }} locale={{ emptyText: <EmptyState compact action={hasFilters ? resetFilters : undefined} actionLabel={t('clearFilters')} description={hasFilters ? t('auditFilteredEmptyDescription') : t('auditEmptyDescription')} /> }} />
    </Card>}

    <Drawer title={selected ? <div className="audit-detail-title"><Typography.Text strong>{translateCode(t, selected.action, 'auditAction')}</Typography.Text><Typography.Text code copyable={{ text: String(selected.id) }}>#{selected.id}</Typography.Text></div> : t('auditDetails')} open={!!selected} onClose={() => setSelected(null)} width={760} destroyOnHidden footer={selected && (resourcePath || selected.taskId) ? <Space>{resourcePath && <Button icon={<ArrowRightOutlined />} onClick={() => openPath(resourcePath)}>{t('viewResource')}</Button>}{selected.taskId && <Button type="primary" onClick={() => openPath(`/tasks?task=${selected.taskId}`)}>{t('viewTask')}</Button>}</Space> : undefined}>
      {selected && <div className="audit-detail">
        <div className={`audit-detail-summary is-${selected.result}`}><span className="audit-detail-icon"><FileSearchOutlined /></span><div><Space wrap><Tag color={selected.result === 'success' ? 'green' : 'red'}>{translateCode(t, selected.result)}</Tag><Typography.Text strong>{translateCode(t, selected.action, 'auditAction')}</Typography.Text></Space><Typography.Paragraph type="secondary">{t('auditTraceDescription', { user: selected.username || '—', time: formatDateTime(selected.createdAt, i18n.language, timezone) })}</Typography.Paragraph></div></div>
        <Descriptions className="audit-detail-meta" bordered size="small" column={2} items={[
          { key: 'resource', label: t('resource'), children: <Space size={6}><Tag>{translateCode(t, selected.resourceType, 'resourceType')}</Tag><span>{selected.resourceName || '—'}</span></Space> },
          { key: 'resourceId', label: t('identifier'), children: selected.resourceId ? <Typography.Text code copyable>{selected.resourceId}</Typography.Text> : '—' },
          { key: 'user', label: t('user'), children: selected.username || '—' },
          { key: 'ip', label: t('ip'), children: selected.ip || '—' },
          { key: 'request', label: t('requestId'), span: 2, children: selected.requestId ? <Typography.Text code copyable>{selected.requestId}</Typography.Text> : '—' },
          { key: 'task', label: t('relatedTask'), span: 2, children: selected.taskId ? <Button type="link" onClick={() => openPath(`/tasks?task=${selected.taskId}`)}>{selected.taskId}</Button> : '—' },
        ]} />
        <Card size="small" title={t('recordedChanges')}>
          {changes.length ? <div className="audit-change-list">{changes.map((change) => <div className="audit-change-row" key={change.key}><Typography.Text strong>{t(`auditChange_${change.key}`, { defaultValue: change.key })}</Typography.Text><div>{'before' in change ? <Space size={9}><Typography.Text code>{changeValue(change.key, change.before)}</Typography.Text><ArrowRightOutlined /><Typography.Text code>{changeValue(change.key, change.after)}</Typography.Text></Space> : <Typography.Text code>{changeValue(change.key, change.value)}</Typography.Text>}</div></div>)}</div> : <EmptyState compact description={t('noRecordedChanges')} />}
        </Card>
        {selected.message && <Card size="small" title={t('message')}><Typography.Paragraph className="audit-message">{t(selected.message, { defaultValue: selected.message })}</Typography.Paragraph>{t(selected.message, { defaultValue: selected.message }) !== selected.message && <Space size={6} wrap><Typography.Text type="secondary">{t('technicalDetails')}</Typography.Text><Typography.Text code copyable>{selected.message}</Typography.Text></Space>}</Card>}
      </div>}
    </Drawer>

    {canManageSettings && <Modal title={t('auditClearTitle')} open={clearOpen} onCancel={closeClear} onOk={() => void clear()} confirmLoading={clearing} closable={!clearing} maskClosable={!clearing} cancelButtonProps={{ disabled: clearing }} okText={t('auditClearConfirm')} okButtonProps={{ danger: true, disabled: confirm !== 'CLEAR' || !clearCutoffValid }} destroyOnHidden>
      <Alert className="audit-clear-warning" type="warning" showIcon message={t('auditDeleteWarning')} />
      {clearError && <Alert className="ops-alert" type="error" showIcon message={t('auditClearFailed')} description={clearError} />}
      <Form layout="vertical">
        <Form.Item label={t('deleteBefore')} validateStatus={clearCutoffValid ? undefined : 'error'} help={clearCutoffValid ? undefined : t('auditClearCutoffRequired')}>
          <DatePicker aria-label={t('deleteBefore')} showTime value={before} onChange={setBefore} disabledDate={(current) => current.isAfter(dayjs(), 'day')} status={clearCutoffValid ? undefined : 'error'} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label={t('typeClearToConfirm')} htmlFor="audit-clear-confirm">
          <Input id="audit-clear-confirm" value={confirm} onChange={(event) => { setConfirm(event.target.value); setClearError('') }} autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>}
  </>
}
