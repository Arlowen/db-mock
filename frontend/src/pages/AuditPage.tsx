import { ArrowRightOutlined, ClearOutlined, DownloadOutlined, EyeOutlined, FileSearchOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Descriptions, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader } from '../components/Common'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { auditChangeEntries, auditResourcePath, auditValueText, isRedactedAuditValue } from '../lib/audit'
import { formatDateTime, translateCode } from '../lib/localization'
import type { Audit } from '../lib/types'

export function AuditPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { message } = App.useApp()
  const navigate = useNavigate()
  const [items, setItems] = useState<Audit[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [resourceType, setResourceType] = useState('')
  const [selected, setSelected] = useState<Audit | null>(null)
  const [clearOpen, setClearOpen] = useState(false)
  const [before, setBefore] = useState<Dayjs>(dayjs().subtract(30, 'day'))
  const [confirm, setConfirm] = useState('')

  const query = new URLSearchParams()
  if (deferredSearch) query.set('search', deferredSearch)
  if (resourceType) query.set('resourceType', resourceType)
  const load = useCallback(() => api<{ items: Audit[] }>(`/audit?${query.toString()}`)
    .then((value) => setItems(value.items))
    .catch((error) => message.error(errorMessage(error)))
    .finally(() => setLoading(false)), [message, deferredSearch, resourceType])
  useEffect(() => { setLoading(true); void load() }, [load])

  const clear = async () => {
    try {
      const result = await api<{ deleted: number }>('/audit/clear', { method: 'POST', body: { before: before.toISOString(), confirm } })
      message.success(t('deletedRecords', { count: result.deleted }))
      setClearOpen(false)
      setConfirm('')
      await load()
    } catch (error) { message.error(errorMessage(error)) }
  }
  const showClear = () => { setBefore(dayjs().subtract(30, 'day')); setConfirm(''); setClearOpen(true) }
  const exportQuery = new URLSearchParams()
  if (search) exportQuery.set('search', search)
  if (resourceType) exportQuery.set('resourceType', resourceType)
  const exportURL = `/api/v1/audit/export?${exportQuery.toString()}`
  const hasFilters = !!(search || resourceType)
  const resetFilters = () => { setSearch(''); setResourceType('') }
  const resourcePath = selected ? auditResourcePath(selected) : ''
  const changes = useMemo(() => auditChangeEntries(selected?.changes), [selected])

  const changeValue = (key: string, value: unknown) => {
    if (isRedactedAuditValue(value)) return t('redacted')
    if (typeof value === 'boolean') return t(value ? 'yes' : 'no')
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
    <PageHeader title={t('audit')} description={t('auditDescription')} actions={<Space><Button href={exportURL} icon={<DownloadOutlined />}>{t('export')}</Button><Button danger icon={<ClearOutlined />} onClick={showClear}>{t('clear')}</Button></Space>} />
    <Card className="audit-table-card">
      <Space wrap className="table-toolbar"><Input value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder={t('search')} style={{ width: 260 }} /><Select value={resourceType} onChange={(value) => { setLoading(true); setResourceType(value) }} style={{ width: 170 }} options={[{ value: '', label: t('allResources') }, ...['platform', 'session', 'user', 'project', 'host', 'instance', 'task', 'image', 'image_upload', 'template', 'registry', 'webhook', 'alert', 'setting', 'audit'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button></Space>
      <Table rowKey="id" loading={loading || search !== deferredSearch} dataSource={items} columns={columns} scroll={{ x: 1250 }} pagination={{ defaultPageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }} locale={{ emptyText: <EmptyState compact action={hasFilters ? resetFilters : undefined} actionLabel={t('clearFilters')} description={t('auditEmptyDescription')} /> }} />
    </Card>

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

    <Modal title={t('clear')} open={clearOpen} onCancel={() => { setClearOpen(false); setConfirm('') }} onOk={() => void clear()} okButtonProps={{ danger: true, disabled: confirm !== 'CLEAR' }}><Typography.Paragraph type="danger">{t('auditDeleteWarning')}</Typography.Paragraph><Form layout="vertical"><Form.Item label={t('deleteBefore')}><DatePicker showTime value={before} onChange={(value) => value && setBefore(value)} style={{ width: '100%' }} /></Form.Item><Form.Item label={t('typeClearToConfirm')} htmlFor="audit-clear-confirm"><Input id="audit-clear-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Form.Item></Form></Modal>
  </>
}
