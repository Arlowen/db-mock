import { ClearOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
import type { Audit } from '../lib/types'

export function AuditPage() {
  const { t, i18n } = useTranslation(); const { message } = App.useApp(); const [items, setItems] = useState<Audit[]>([]); const [search, setSearch] = useState(''); const [resourceType, setResourceType] = useState(''); const [clearOpen, setClearOpen] = useState(false); const [before, setBefore] = useState<Dayjs>(dayjs().subtract(30, 'day')); const [confirm, setConfirm] = useState('')
  const query = new URLSearchParams(); if (search) query.set('search', search); if (resourceType) query.set('resourceType', resourceType)
  const load = useCallback(() => api<{ items: Audit[] }>(`/audit?${query.toString()}`).then((value) => setItems(value.items)).catch((error) => message.error(errorMessage(error))), [message, search, resourceType])
  useEffect(() => { void load() }, [load])
  const clear = async () => { try { const result = await api<{ deleted: number }>('/audit/clear', { method: 'POST', body: { before: before.toISOString(), confirm } }); message.success(t('deletedRecords', { count: result.deleted })); setClearOpen(false); setConfirm(''); await load() } catch (error) { message.error(errorMessage(error)) } }
  const exportURL = `/api/v1/audit/export?${query.toString()}`
  return <><PageHeader title={t('audit')} description={t('auditDescription')} actions={<Space><Button href={exportURL} icon={<DownloadOutlined />}>{t('export')}</Button><Button danger icon={<ClearOutlined />} onClick={() => setClearOpen(true)}>{t('clear')}</Button></Space>} /><Card><Space wrap className="table-toolbar"><Input value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder={t('search')} style={{ width: 260 }} /><Select value={resourceType} onChange={setResourceType} style={{ width: 170 }} options={[{ value: '', label: t('allResources') }, ...['platform', 'session', 'user', 'project', 'host', 'instance', 'task', 'image', 'template', 'webhook', 'setting'].map((value) => ({ value, label: translateCode(t, value, 'resourceType') }))]} /><Button icon={<ReloadOutlined />} onClick={() => void load()}>{t('refresh')}</Button></Space><Table rowKey="id" dataSource={items} scroll={{ x: 1000 }} columns={[{ title: t('time'), dataIndex: 'createdAt', render: (value: string) => formatDateTime(value, i18n.language) },{ title: t('user'), dataIndex: 'username' },{ title: t('action'), dataIndex: 'action', render: (value: string) => <Typography.Text code>{translateCode(t, value, 'auditAction')}</Typography.Text> },{ title: t('resources'), render: (_: unknown, item: Audit) => <><Tag>{translateCode(t, item.resourceType, 'resourceType')}</Tag>{item.resourceName || '—'}</> },{ title: t('result'), dataIndex: 'result', render: (value: string) => <Tag color={value === 'success' ? 'green' : 'red'}>{translateCode(t, value)}</Tag> },{ title: t('ip'), dataIndex: 'ip' },{ title: t('message'), dataIndex: 'message' }]} /></Card>
    <Modal title={t('clear')} open={clearOpen} onCancel={() => setClearOpen(false)} onOk={() => void clear()} okButtonProps={{ danger: true, disabled: confirm !== 'CLEAR' }}><Typography.Paragraph type="danger">{t('auditDeleteWarning')}</Typography.Paragraph><Form layout="vertical"><Form.Item label={t('deleteBefore')}><DatePicker showTime value={before} onChange={(value) => value && setBefore(value)} style={{ width: '100%' }} /></Form.Item><Form.Item label={t('typeClearToConfirm')}><Input value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Form.Item></Form></Modal>
  </>
}
