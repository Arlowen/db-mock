import { ClearOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import type { Audit } from '../lib/types'

export function AuditPage() {
  const { t } = useTranslation(); const { message } = App.useApp(); const [items, setItems] = useState<Audit[]>([]); const [search, setSearch] = useState(''); const [resourceType, setResourceType] = useState(''); const [clearOpen, setClearOpen] = useState(false); const [before, setBefore] = useState<Dayjs>(dayjs().subtract(30, 'day')); const [confirm, setConfirm] = useState('')
  const query = new URLSearchParams(); if (search) query.set('search', search); if (resourceType) query.set('resourceType', resourceType)
  const load = useCallback(() => api<{ items: Audit[] }>(`/audit?${query.toString()}`).then((value) => setItems(value.items)).catch((error) => message.error(errorMessage(error))), [message, search, resourceType])
  useEffect(() => { void load() }, [load])
  const clear = async () => { try { const result = await api<{ deleted: number }>('/audit/clear', { method: 'POST', body: { before: before.toISOString(), confirm } }); message.success(`Deleted ${result.deleted} records`); setClearOpen(false); setConfirm(''); await load() } catch (error) { message.error(errorMessage(error)) } }
  const exportURL = `/api/v1/audit/export?${query.toString()}`
  return <><PageHeader title={t('audit')} description="Permanent operation history. Export or explicitly clear records when required." actions={<Space><Button href={exportURL} icon={<DownloadOutlined />}>{t('export')}</Button><Button danger icon={<ClearOutlined />} onClick={() => setClearOpen(true)}>{t('clear')}</Button></Space>} /><Card><Space wrap className="table-toolbar"><Input value={search} onChange={(event) => setSearch(event.target.value)} allowClear prefix={<SearchOutlined />} placeholder={t('search')} style={{ width: 260 }} /><Select value={resourceType} onChange={setResourceType} style={{ width: 170 }} options={[{ value: '', label: 'All resources' }, ...['platform', 'session', 'user', 'project', 'host', 'instance', 'task', 'image', 'template', 'webhook', 'setting'].map((value) => ({ value, label: value }))]} /><Button icon={<ReloadOutlined />} onClick={() => void load()}>{t('refresh')}</Button></Space><Table rowKey="id" dataSource={items} scroll={{ x: 1000 }} columns={[{ title: 'Time', dataIndex: 'createdAt', render: (value: string) => new Date(value).toLocaleString() },{ title: 'User', dataIndex: 'username' },{ title: 'Action', dataIndex: 'action', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },{ title: t('resources'), render: (_: unknown, item: Audit) => <><Tag>{item.resourceType}</Tag>{item.resourceName || '—'}</> },{ title: 'Result', dataIndex: 'result', render: (value: string) => <Tag color={value === 'success' ? 'green' : 'red'}>{value}</Tag> },{ title: 'IP', dataIndex: 'ip' },{ title: 'Message', dataIndex: 'message' }]} /></Card>
    <Modal title={t('clear')} open={clearOpen} onCancel={() => setClearOpen(false)} onOk={() => void clear()} okButtonProps={{ danger: true, disabled: confirm !== 'CLEAR' }}><Typography.Paragraph type="danger">Audit records before this timestamp will be permanently deleted.</Typography.Paragraph><Form layout="vertical"><Form.Item label="Delete before"><DatePicker showTime value={before} onChange={(value) => value && setBefore(value)} style={{ width: '100%' }} /></Form.Item><Form.Item label="Type CLEAR to confirm"><Input value={confirm} onChange={(event) => setConfirm(event.target.value)} /></Form.Item></Form></Modal>
  </>
}
