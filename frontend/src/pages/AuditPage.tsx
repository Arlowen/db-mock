import { ClearOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useDeferredValue, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
import type { Audit } from '../lib/types'

export function AuditPage() {
  const { t, i18n } = useTranslation(); const { message } = App.useApp(); const [items, setItems] = useState<Audit[]>([]); const [loading, setLoading] = useState(true); const [search, setSearch] = useState(''); const deferredSearch = useDeferredValue(search); const [resourceType, setResourceType] = useState(''); const [clearOpen, setClearOpen] = useState(false); const [before, setBefore] = useState<Dayjs>(dayjs().subtract(30, 'day')); const [confirm, setConfirm] = useState('')
  const query = new URLSearchParams(); if (deferredSearch) query.set('search', deferredSearch); if (resourceType) query.set('resourceType', resourceType)
  const load = useCallback(() => api<{ items: Audit[] }>(`/audit?${query.toString()}`).then((value) => setItems(value.items)).catch((error) => message.error(errorMessage(error))).finally(() => setLoading(false)), [message, deferredSearch, resourceType])
  useEffect(() => { setLoading(true); void load() }, [load])
  const clear = async () => { try { const result = await api<{ deleted: number }>('/audit/clear', { method: 'POST', body: { before: before.toISOString(), confirm } }); message.success(t('deletedRecords', { count: result.deleted })); setClearOpen(false); setConfirm(''); await load() } catch (error) { message.error(errorMessage(error)) } }
  const showClear = () => { setBefore(dayjs().subtract(30, 'day')); setConfirm(''); setClearOpen(true) }
  const exportQuery = new URLSearchParams(); if (search) exportQuery.set('search', search); if (resourceType) exportQuery.set('resourceType', resourceType)
  const exportURL = `/api/v1/audit/export?${exportQuery.toString()}`
  const hasFilters = !!(search || resourceType)
  const resetFilters = () => { setSearch(''); setResourceType('') }
  return <><PageHeader title={t('audit')} description={t('auditDescription')} actions={<Space><Button href={exportURL} icon={<DownloadOutlined />}>{t('export')}</Button><Button danger icon={<ClearOutlined />} onClick={showClear}>{t('clear')}</Button></Space>} />
    <Card><Space wrap className="table-toolbar"><Input value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder={t('search')} style={{ width: 260 }} /><Select value={resourceType} onChange={(value) => { setLoading(true); setResourceType(value) }} style={{ width: 170 }} options={[{ value: '', label: t('allResources') }, ...['platform', 'session', 'user', 'project', 'host', 'instance', 'task', 'image', 'template', 'webhook', 'setting'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Button icon={<ReloadOutlined />} onClick={() => { setLoading(true); void load() }}>{t('refresh')}</Button></Space><Table rowKey="id" loading={loading || search !== deferredSearch} dataSource={items} scroll={{ x: 1000 }} locale={{ emptyText: <EmptyState compact action={hasFilters ? resetFilters : undefined} actionLabel={t('clearFilters')} description={t('auditEmptyDescription')} /> }} columns={[{ title: t('time'), dataIndex: 'createdAt', render: (value: string) => formatDateTime(value, i18n.language) },{ title: t('user'), dataIndex: 'username' },{ title: t('action'), dataIndex: 'action', render: (value: string) => <Typography.Text code>{translateCode(t, value, 'auditAction')}</Typography.Text> },{ title: t('resources'), render: (_: unknown, item: Audit) => <><Tag>{translateCode(t, item.resourceType, 'resourceType')}</Tag>{item.resourceName || '—'}</> },{ title: t('result'), dataIndex: 'result', render: (value: string) => <Tag color={value === 'success' ? 'green' : 'red'}>{translateCode(t, value)}</Tag> },{ title: t('ip'), dataIndex: 'ip' },{ title: t('message'), dataIndex: 'message' }]} /></Card>
    <Modal title={t('clear')} open={clearOpen} onCancel={() => { setClearOpen(false); setConfirm('') }} onOk={() => void clear()} okButtonProps={{ danger: true, disabled: confirm !== 'CLEAR' }}><Typography.Paragraph type="danger">{t('auditDeleteWarning')}</Typography.Paragraph><Form layout="vertical"><Form.Item label={t('deleteBefore')}><DatePicker showTime value={before} onChange={(value) => value && setBefore(value)} style={{ width: '100%' }} /></Form.Item><Form.Item label={t('typeClearToConfirm')} htmlFor="audit-clear-confirm"><Input id="audit-clear-confirm" value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Form.Item></Form></Modal>
  </>
}
