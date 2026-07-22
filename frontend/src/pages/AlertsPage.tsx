import {
  BellOutlined, DeleteOutlined, EditOutlined, HistoryOutlined, LinkOutlined, PlusOutlined, ReloadOutlined, SendOutlined,
} from '@ant-design/icons'
import {
  Alert as InlineAlert, App, Button, Card, Checkbox, Col, Descriptions, Drawer, Form, Input, Modal, Popconfirm, Row,
  Segmented, Select, Space, Switch, Table, Tabs, Tag, Typography,
} from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { formatDateTime, translateCode } from '../lib/localization'
import { permissionsFor } from '../lib/permissions'
import type { Alert as AlertItem, Host, Instance, Webhook, WebhookDelivery } from '../lib/types'
import { normalizeWebhookEvents } from '../lib/webhook-events'

const webhookEvents = [
  '*', 'alert.created', 'instance.failed', 'instance.restart_failed', 'host.offline', 'host.disk_warning',
  'host.disk_critical', 'task.finished', 'task.succeeded', 'task.failed', 'webhook.test',
]

function eventKey(value: string) {
  return `event_${value === '*' ? 'all' : value.replaceAll('.', '_')}`
}

interface WebhookValues {
  name: string
  url: string
  secret?: string
  clearSecret?: boolean
  events: string[]
  enabled: boolean
}

export function AlertsPage() {
  const { t, i18n } = useTranslation()
  const { user } = useAuth()
  const { canOperate } = permissionsFor(user!)
  const { timezone } = useSystemSettings()
  const { message } = App.useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const [form] = Form.useForm<WebhookValues>()
  const [alerts, setAlerts] = useState<AlertItem[]>([])
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [hosts, setHosts] = useState<Host[]>([])
  const [instances, setInstances] = useState<Instance[]>([])
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [deliveryLoading, setDeliveryLoading] = useState(false)
  const [deliveryError, setDeliveryError] = useState('')
  const [saving, setSaving] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Webhook | null>(null)
  const [actioning, setActioning] = useState('')
  const [focusedDeliveryID, setFocusedDeliveryID] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('active')
  const [severityFilter, setSeverityFilter] = useState('')
  const clearWebhookSecret = Form.useWatch('clearSecret', form)

  const query = useMemo(() => new URLSearchParams(location.search), [location.search])
  const activeTab = canOperate && query.get('tab') === 'webhooks' ? 'webhooks' : 'alerts'
  const selectedAlertID = query.get('alert') || ''
  const selectedWebhookID = query.get('webhook') || ''

  const setQuery = useCallback((values: Record<string, string | undefined>) => {
    const next = new URLSearchParams(location.search)
    Object.entries(values).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key))
    navigate({ pathname: '/alerts', search: next.toString() ? `?${next}` : '' })
  }, [location.search, navigate])

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const [alertResponse, webhookResponse, hostResponse, instanceResponse] = await Promise.all([
        api<{ items: AlertItem[] }>('/alerts'),
        canOperate ? api<{ items: Webhook[] }>('/webhooks') : Promise.resolve({ items: [] as Webhook[] }),
        api<{ items: Host[] }>('/hosts'),
        api<{ items: Instance[] }>('/instances'),
      ])
      setAlerts(alertResponse.items)
      setWebhooks(webhookResponse.items)
      setHosts(hostResponse.items)
      setInstances(instanceResponse.items)
      setLoadError('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [canOperate])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(true), 10000)
    return () => window.clearInterval(timer)
  }, [load])

  const loadDeliveries = useCallback(async (webhookID: string, silent = false) => {
    if (!silent) setDeliveryLoading(true)
    try {
      const response = await api<{ items: WebhookDelivery[] }>(`/webhooks/${webhookID}/deliveries`)
      setDeliveries(response.items)
      setDeliveryError('')
    } catch (error) {
      setDeliveryError(errorMessage(error))
    } finally {
      if (!silent) setDeliveryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!canOperate || !selectedWebhookID) {
      setDeliveries([])
      setDeliveryError('')
      return
    }
    void loadDeliveries(selectedWebhookID)
    const timer = window.setInterval(() => void loadDeliveries(selectedWebhookID, true), 2500)
    return () => window.clearInterval(timer)
  }, [canOperate, loadDeliveries, selectedWebhookID])

  const hostNames = useMemo(() => new Map(hosts.map((item) => [item.id, item.name])), [hosts])
  const instanceNames = useMemo(() => new Map(instances.map((item) => [item.id, item.name])), [instances])
  const hostsByID = useMemo(() => new Map(hosts.map((item) => [item.id, item])), [hosts])
  const instancesByID = useMemo(() => new Map(instances.map((item) => [item.id, item])), [instances])
  const selectedAlert = alerts.find((item) => item.id === selectedAlertID)
  const selectedWebhook = webhooks.find((item) => item.id === selectedWebhookID)
  const activeAlertCount = alerts.filter((item) => item.status !== 'resolved').length

  const resourceFor = useCallback((item: AlertItem) => {
    if (item.resourceType === 'host') {
      const name = hostNames.get(item.resourceId)
      return { name: name || t('resourceUnavailable'), path: name ? `/hosts?host=${item.resourceId}` : '' }
    }
    if (item.resourceType === 'instance') {
      const name = instanceNames.get(item.resourceId)
      return { name: name || t('resourceUnavailable'), path: name ? `/instances/${item.resourceId}` : '' }
    }
    return { name: item.resourceId.slice(0, 8), path: '' }
  }, [hostNames, instanceNames, t])

  const resourceStateFor = useCallback((item: AlertItem) => {
    if (item.resourceType === 'host') {
      const host = hostsByID.get(item.resourceId)
      return host ? { name: host.name, status: host.status, healthy: host.status === 'online' } : undefined
    }
    if (item.resourceType === 'instance') {
      const instance = instancesByID.get(item.resourceId)
      const healthy = instance?.status === 'running' || (instance?.status === 'stopped' && instance.desiredState === 'stopped')
      return instance ? { name: instance.name, status: instance.status, healthy } : undefined
    }
    return undefined
  }, [hostsByID, instancesByID])
  const selectedResourceState = selectedAlert ? resourceStateFor(selectedAlert) : undefined
  const relatedActiveAlerts = selectedAlert ? alerts.filter((item) => item.id !== selectedAlert.id && item.resourceType === selectedAlert.resourceType && item.resourceId === selectedAlert.resourceId && item.status !== 'resolved').slice(0, 5) : []
  const selectedDiagnosticEntries = selectedAlert ? Object.entries(selectedAlert.details || {}).slice(0, 8) : []

  const summaryFor = useCallback((item: AlertItem) => t(`alertSummary_${item.type}`, { defaultValue: item.message }), [t])
  const filteredAlerts = useMemo(() => alerts.filter((item) => {
    const resource = resourceFor(item)
    const normalized = search.trim().toLowerCase()
    const statusMatches = statusFilter === 'all' || (statusFilter === 'active' ? item.status !== 'resolved' : item.status === statusFilter)
    const severityMatches = !severityFilter || item.severity === severityFilter
    const searchMatches = !normalized || [item.title, item.message, summaryFor(item), resource.name].some((value) => value.toLowerCase().includes(normalized))
    return statusMatches && severityMatches && searchMatches
  }), [alerts, resourceFor, search, severityFilter, statusFilter, summaryFor])

  const setAlertStatus = async (item: AlertItem, status: 'acknowledged' | 'resolved') => {
    try {
      setActioning(`${item.id}:${status}`)
      await api(`/alerts/${item.id}/${status}`, { method: 'POST', body: {} })
      message.success(t(status === 'acknowledged' ? 'alertAcknowledgedSuccess' : 'alertResolvedSuccess'))
      await load(true)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
    }
  }

  const showCreateWebhook = () => {
    setEditing(null)
    form.resetFields()
    form.setFieldsValue({ enabled: true, events: ['alert.created'], clearSecret: false })
    setFormOpen(true)
  }

  const showEditWebhook = (item: Webhook) => {
    setEditing(item)
    form.resetFields()
    form.setFieldsValue({ name: item.name, url: item.url, secret: '', clearSecret: false, events: item.events, enabled: item.enabled })
    setFormOpen(true)
  }

  const saveWebhook = async () => {
    try {
      setSaving(true)
      const values = await form.validateFields()
      await api(editing ? `/webhooks/${editing.id}` : '/webhooks', {
        method: editing ? 'PUT' : 'POST',
        body: values,
      })
      message.success(t('saved'))
      setFormOpen(false)
      form.resetFields()
      await load(true)
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const updateWebhookEnabled = async (item: Webhook, enabled: boolean) => {
    try {
      setActioning(`toggle:${item.id}`)
      await api(`/webhooks/${item.id}`, {
        method: 'PUT',
        body: { name: item.name, url: item.url, secret: '', clearSecret: false, events: item.events, enabled },
      })
      await load(true)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
    }
  }

  const testWebhook = async (item: Webhook) => {
    try {
      setActioning(`test:${item.id}`)
      const response = await api<{ queued: boolean; deliveryId: string }>(`/webhooks/${item.id}/test`, { method: 'POST', body: {} })
      setFocusedDeliveryID(response.deliveryId)
      setQuery({ tab: 'webhooks', webhook: item.id, alert: undefined })
      message.success(t('webhookQueued'))
      await loadDeliveries(item.id, true)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
    }
  }

  const deleteWebhook = async (item: Webhook) => {
    try {
      setActioning(`delete:${item.id}`)
      await api(`/webhooks/${item.id}`, { method: 'DELETE' })
      if (selectedWebhookID === item.id) setQuery({ webhook: undefined })
      await load(true)
      message.success(t('delete'))
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
    }
  }

  const retryDelivery = async (item: WebhookDelivery) => {
    try {
      setActioning(`retry:${item.id}`)
      await api(`/webhooks/${item.webhookId}/deliveries/${item.id}/retry`, { method: 'POST', body: {} })
      setFocusedDeliveryID(item.id)
      message.success(t('deliveryRetryQueued'))
      await loadDeliveries(item.webhookId, true)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setActioning('')
    }
  }

  const openResource = (item: AlertItem) => {
    const resource = resourceFor(item)
    if (resource.path) navigate(resource.path)
  }

  const alertActor = (value?: string) => value === 'system' ? t('systemActor') : value || '—'
  const resolutionConfirmationFor = (item: AlertItem) => {
    const state = resourceStateFor(item)
    return state && !state.healthy
      ? t('alertResolveUnhealthyConfirm', { name: state.name, status: translateCode(t, state.status) })
      : t('alertResolveConfirm')
  }

  const alertColumns = [
    {
      title: t('status'), width: 100,
      render: (_: unknown, item: AlertItem) => <Space direction="vertical" size={4}><StatusTag value={item.severity} /><StatusTag value={item.status} /></Space>,
    },
    {
      title: t('alertEvents'), width: 270,
      render: (_: unknown, item: AlertItem) => <div className="alert-title-cell"><Button type="link" onClick={() => setQuery({ tab: 'alerts', alert: item.id, webhook: undefined })}>{t(`alertTitle_${item.type}`, { defaultValue: item.title })}</Button><Typography.Text type="secondary" ellipsis={{ tooltip: summaryFor(item) }}>{summaryFor(item)}</Typography.Text></div>,
    },
    {
      title: t('resource'), width: 190,
      render: (_: unknown, item: AlertItem) => {
        const resource = resourceFor(item)
        return <div className="alert-resource"><Tag>{translateCode(t, item.resourceType, 'resourceType')}</Tag>{resource.path ? <Button type="link" icon={<LinkOutlined />} onClick={() => navigate(resource.path)}>{resource.name}</Button> : <Typography.Text type="secondary">{resource.name}</Typography.Text>}</div>
      },
    },
    { title: t('alertFirstSeen'), dataIndex: 'createdAt', width: 150, render: (value: string) => formatDateTime(value, i18n.language, timezone) },
    {
      title: t('actions'), width: 220,
      render: (_: unknown, item: AlertItem) => <Space className="alert-table-actions">
        {canOperate && item.status === 'open' && <Button size="small" loading={actioning === `${item.id}:acknowledged`} disabled={!!actioning && actioning !== `${item.id}:acknowledged`} onClick={() => void setAlertStatus(item, 'acknowledged')}>{t('acknowledge')}</Button>}
        {canOperate && item.status !== 'resolved' && <Popconfirm title={t('alertResolveConfirmTitle')} description={resolutionConfirmationFor(item)} okText={t('resolve')} cancelText={t('cancel')} onConfirm={() => void setAlertStatus(item, 'resolved')}><Button size="small" type="primary" loading={actioning === `${item.id}:resolved`} disabled={!!actioning && actioning !== `${item.id}:resolved`}>{t('resolve')}</Button></Popconfirm>}
        <Button size="small" type="link" onClick={() => setQuery({ tab: 'alerts', alert: item.id, webhook: undefined })}>{t('details')}</Button>
      </Space>,
    },
  ]

  const alertTab = <>
    <Card className="table-filter-card"><div className="alert-toolbar"><Input.Search allowClear aria-label={t('search')} placeholder={t('search')} value={search} onChange={(event) => setSearch(event.target.value)} /><Segmented aria-label={t('status')} value={statusFilter} onChange={(value) => setStatusFilter(String(value))} options={[
      { value: 'active', label: `${t('activeAlerts')} ${activeAlertCount}` },
      { value: 'open', label: t('open') },
      { value: 'acknowledged', label: t('acknowledged') },
      { value: 'resolved', label: t('resolved') },
      { value: 'all', label: t('all') },
    ]} /><Select aria-label={t('severity')} value={severityFilter} onChange={setSeverityFilter} options={[
      { value: '', label: t('allSeverities') },
      { value: 'critical', label: t('critical') },
      { value: 'warning', label: t('warning') },
      { value: 'info', label: t('info', { defaultValue: 'Info' }) },
    ]} /></div></Card>
    <Card className="alert-table-card"><Table rowKey="id" loading={loading} dataSource={filteredAlerts} columns={alertColumns} tableLayout="fixed" pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 930 }} locale={{ emptyText: <EmptyState compact action={(search || statusFilter !== 'active' || severityFilter) ? () => { setSearch(''); setStatusFilter('active'); setSeverityFilter('') } : undefined} actionLabel={t('clearFilters')} description={(search || statusFilter !== 'active' || severityFilter) ? t('alertFilteredEmptyDescription') : t('alertsEmptyDescription')} /> }} /></Card>
  </>

  const webhookTab = loading ? <Card loading /> : <Row gutter={[16, 16]} className="webhook-grid">
    {webhooks.map((item) => <Col xs={24} lg={12} xl={8} key={item.id}><Card className="webhook-card">
      <div className="webhook-card-header"><div><Typography.Title level={4}>{item.name}</Typography.Title><Typography.Text type="secondary">{formatDateTime(item.updatedAt, i18n.language, timezone)}</Typography.Text></div><Switch aria-label={`${item.name} ${t('enabled')}`} checked={item.enabled} loading={actioning === `toggle:${item.id}`} onChange={(value) => void updateWebhookEnabled(item, value)} /></div>
      <Typography.Text className="webhook-url" copyable ellipsis={{ tooltip: item.url }}>{item.url}</Typography.Text>
      <div className="webhook-event-list">{item.events.map((event) => <Tag key={event}>{t(eventKey(event), { defaultValue: event })}</Tag>)}</div>
      <div className="webhook-security"><StatusTag value={item.enabled ? 'enabled' : 'disabled'} />{item.hasSecret && <Typography.Text type="secondary">{t('hmacSigningEnabled')}</Typography.Text>}</div>
      <div className="webhook-delivery-facts"><div><Typography.Text type="secondary">{t('lastDelivery')}</Typography.Text><Space size={6}>{item.lastDeliveryStatus ? <StatusTag value={item.lastDeliveryStatus} /> : <Typography.Text>{t('notTested')}</Typography.Text>}{item.lastDeliveryAt && <Typography.Text type="secondary">{formatDateTime(item.lastDeliveryAt, i18n.language, timezone)}</Typography.Text>}</Space></div><div><Typography.Text type="secondary">{t('deliveryQueue')}</Typography.Text><Space size={6}>{item.failedDeliveries > 0 && <Tag color="red">{t('failedDeliveryCount', { count: item.failedDeliveries })}</Tag>}{item.queuedDeliveries > 0 && <Tag color="gold">{t('queuedDeliveryCount', { count: item.queuedDeliveries })}</Tag>}{!item.failedDeliveries && !item.queuedDeliveries && <Typography.Text>{t('queueClear')}</Typography.Text>}</Space></div></div>
      <div className="webhook-card-footer"><Button icon={<HistoryOutlined />} onClick={() => setQuery({ tab: 'webhooks', webhook: item.id, alert: undefined })}>{t('deliveryHistory')}</Button><Space><Button icon={<EditOutlined />} onClick={() => showEditWebhook(item)}>{t('edit')}</Button><Button type="primary" icon={<SendOutlined />} loading={actioning === `test:${item.id}`} disabled={!item.enabled || (!!actioning && actioning !== `test:${item.id}`)} onClick={() => void testWebhook(item)}>{t('testWebhook')}</Button><Popconfirm title={t('delete')} description={t('webhookDeleteConfirm')} okButtonProps={{ danger: true }} onConfirm={() => void deleteWebhook(item)}><Button danger aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} loading={actioning === `delete:${item.id}`} /></Popconfirm></Space></div>
    </Card></Col>)}
    {webhooks.length === 0 && <Col span={24}><Card><EmptyState action={showCreateWebhook} actionLabel={t('addWebhook')} description={t('webhooksEmptyDescription')} /></Card></Col>}
  </Row>

  return <>
    <PageHeader title={t('alerts')} description={t('alertInboxDescription')} actions={<><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('refresh')}</Button>{canOperate && <Button type="primary" icon={<PlusOutlined />} onClick={showCreateWebhook}>{t('addWebhook')}</Button>}</>} />
    {loadError && <InlineAlert className="instance-page-alert" type="error" showIcon message={t('alertListLoadFailed')} description={loadError} action={<Button size="small" onClick={() => void load()}>{t('retry')}</Button>} />}
    <Tabs activeKey={activeTab} onChange={(tab) => setQuery({ tab: tab === 'webhooks' ? 'webhooks' : undefined, alert: undefined, webhook: undefined })} items={[
      { key: 'alerts', label: <Space size={6}>{t('alertEvents')}<Tag color={activeAlertCount ? 'orange' : 'default'}>{activeAlertCount}</Tag></Space>, children: alertTab },
      ...(canOperate ? [{ key: 'webhooks', label: <Space size={6}>{t('webhook')}<Tag>{webhooks.length}</Tag></Space>, children: webhookTab }] : []),
    ]} />

    <Drawer title={t('alertDetails')} width={620} open={!!selectedAlertID} onClose={() => setQuery({ alert: undefined })} footer={selectedAlert ? <div className="alert-drawer-footer"><Button icon={<LinkOutlined />} disabled={!resourceFor(selectedAlert).path} onClick={() => openResource(selectedAlert)}>{t('viewResource')}</Button>{canOperate && <Space>{selectedAlert.status === 'open' && <Button loading={actioning === `${selectedAlert.id}:acknowledged`} onClick={() => void setAlertStatus(selectedAlert, 'acknowledged')}>{t('acknowledge')}</Button>}{selectedAlert.status !== 'resolved' && <Popconfirm title={t('alertResolveConfirmTitle')} description={resolutionConfirmationFor(selectedAlert)} okText={t('resolve')} cancelText={t('cancel')} onConfirm={() => void setAlertStatus(selectedAlert, 'resolved')}><Button type="primary" loading={actioning === `${selectedAlert.id}:resolved`}>{t('resolve')}</Button></Popconfirm>}</Space>}</div> : undefined}>
      {selectedAlert ? <div className="alert-detail"><div className={`alert-detail-summary severity-${selectedAlert.severity}`}><div className="alert-detail-icon"><BellOutlined /></div><div><Space wrap><StatusTag value={selectedAlert.severity} /><StatusTag value={selectedAlert.status} /></Space><Typography.Title level={4}>{t(`alertTitle_${selectedAlert.type}`, { defaultValue: selectedAlert.title })}</Typography.Title><Typography.Paragraph>{summaryFor(selectedAlert)}</Typography.Paragraph></div></div>{selectedResourceState ? <InlineAlert className="alert-resource-health" type={selectedResourceState.healthy ? 'success' : 'warning'} showIcon message={t(selectedResourceState.healthy ? 'alertResourceRecovered' : 'alertResourceStillUnhealthy')} description={t(selectedResourceState.healthy ? 'alertResourceRecoveredHint' : 'alertResourceUnhealthyHint', { name: selectedResourceState.name, status: translateCode(t, selectedResourceState.status) })} action={<Button size="small" icon={<LinkOutlined />} onClick={() => openResource(selectedAlert)}>{t('inspectAffectedResource')}</Button>} /> : <InlineAlert type="warning" showIcon message={t('resourceUnavailable')} description={t('alertResourceUnavailableHint')} />}{relatedActiveAlerts.length > 0 && <Card size="small" title={t('relatedActiveAlerts')}><div className="related-alert-list">{relatedActiveAlerts.map((item) => <div className="related-alert-item" key={item.id}><StatusTag value={item.severity} /><div><Button type="link" onClick={() => setQuery({ tab: 'alerts', alert: item.id, webhook: undefined })}>{t(`alertTitle_${item.type}`, { defaultValue: item.title })}</Button><Typography.Text type="secondary">{summaryFor(item)}</Typography.Text></div><StatusTag value={item.status} /></div>)}</div></Card>}{selectedDiagnosticEntries.length > 0 && <Card size="small" title={t('alertDiagnostics')}><Descriptions className="alert-diagnostic-details" size="small" column={1} items={selectedDiagnosticEntries.map(([key, value]) => ({ key, label: t(`alertDetail_${key}`, { defaultValue: key }), children: typeof value === 'string' ? <Typography.Text code>{value}</Typography.Text> : typeof value === 'object' ? <Typography.Text code>{JSON.stringify(value)}</Typography.Text> : String(value) }))} /></Card>}<InlineAlert type="info" showIcon message={t('technicalDetails')} description={<Typography.Text code copyable>{selectedAlert.message}</Typography.Text>} /><Card size="small" title={t('alertLifecycle')}><Descriptions size="small" column={1} items={[
        { key: 'created', label: t('alertFirstSeen'), children: formatDateTime(selectedAlert.createdAt, i18n.language, timezone) },
        { key: 'acknowledged', label: t('alertAcknowledgedAt'), children: formatDateTime(selectedAlert.acknowledgedAt, i18n.language, timezone) },
        { key: 'acknowledgedBy', label: t('alertAcknowledgedBy'), children: alertActor(selectedAlert.acknowledgedBy) },
        { key: 'resolved', label: t('alertResolvedAt'), children: formatDateTime(selectedAlert.resolvedAt, i18n.language, timezone) },
        { key: 'resolvedBy', label: t('alertResolvedBy'), children: alertActor(selectedAlert.resolvedBy) },
        { key: 'id', label: t('identifier'), children: <Typography.Text code copyable>{selectedAlert.id}</Typography.Text> },
      ]} /></Card></div> : !loading && <EmptyState compact description={t('resourceUnavailable')} />}
    </Drawer>

    <Modal title={editing ? t('editWebhook') : t('addWebhook')} open={formOpen} onCancel={() => { if (!saving) setFormOpen(false) }} onOk={() => void saveWebhook()} confirmLoading={saving} okText={t('save')} width={620}>
      <Typography.Paragraph type="secondary" className="webhook-form-description">{t('webhookFormDescription')}</Typography.Paragraph>
      <Form form={form} layout="vertical" autoComplete="off">
        <Form.Item name="name" label={t('name')} rules={[{ required: true, whitespace: true }]}><Input aria-label={t('name')} maxLength={120} placeholder={t('webhookNamePlaceholder')} /></Form.Item>
        <Form.Item name="url" label={t('url')} extra={t('webhookURLHint')} rules={[{ required: true }, { type: 'url' }]}><Input aria-label={t('url')} type="url" maxLength={2048} placeholder={t('webhookURLPlaceholder')} /></Form.Item>
        <div className="webhook-secret-field"><Form.Item name="secret" label={t('hmacSecret')} extra={t(editing?.hasSecret ? 'webhookSecretEditHint' : 'webhookSecretCreateHint')}><Input.Password aria-label={t('hmacSecret')} maxLength={4096} disabled={!!clearWebhookSecret} autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>{editing?.hasSecret && <Form.Item name="clearSecret" valuePropName="checked"><Checkbox onChange={(event) => { if (event.target.checked) form.setFieldValue('secret', '') }}>{t('removeWebhookSecret')}</Checkbox></Form.Item>}</div>
        <Form.Item name="events" label={t('webhookEvents')} extra={t('webhookEventsHint')} normalize={(values: string[], previous: string[]) => normalizeWebhookEvents(previous || [], values || [])} rules={[{ required: true }]}><Select aria-label={t('webhookEvents')} mode="multiple" maxTagCount="responsive" options={webhookEvents.map((value) => ({ value, label: t(eventKey(value), { defaultValue: value }) }))} /></Form.Item>
        <Form.Item name="enabled" label={t('enabled')} valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>

    <Drawer title={selectedWebhook ? `${t('deliveryHistory')} · ${selectedWebhook.name}` : t('deliveryHistory')} width={760} open={canOperate && !!selectedWebhookID} onClose={() => { setFocusedDeliveryID(''); setQuery({ webhook: undefined }) }} extra={selectedWebhook && <Button type="primary" icon={<SendOutlined />} loading={actioning === `test:${selectedWebhook.id}`} disabled={!selectedWebhook.enabled} onClick={() => void testWebhook(selectedWebhook)}>{t('testWebhook')}</Button>}>
      {selectedWebhook && <div className="delivery-webhook-summary"><div><Space><StatusTag value={selectedWebhook.enabled ? 'enabled' : 'disabled'} />{selectedWebhook.hasSecret && <Tag>{t('hmacSigningEnabled')}</Tag>}</Space><Typography.Text copyable ellipsis={{ tooltip: selectedWebhook.url }}>{selectedWebhook.url}</Typography.Text></div><Typography.Paragraph type="secondary">{t('deliveryHistoryDescription')}</Typography.Paragraph></div>}
      {deliveryError && <InlineAlert className="ops-alert" type="error" showIcon message={t('deliveryLoadFailed')} description={deliveryError} action={<Button size="small" onClick={() => selectedWebhookID && void loadDeliveries(selectedWebhookID)}>{t('retry')}</Button>} />}
      <Table rowKey="id" size="small" loading={deliveryLoading} dataSource={deliveries} pagination={false} rowClassName={(item) => item.id === focusedDeliveryID ? 'delivery-row-focused' : ''} locale={{ emptyText: <EmptyState compact description={t('noDeliveries')} /> }} expandable={{ rowExpandable: (item) => !!(item.errorMessage || item.responseBody), expandedRowRender: (item) => <Descriptions className="delivery-details" size="small" column={1} items={[
        { key: 'error', label: t('errorDetail'), children: item.errorMessage ? <Typography.Text type="danger" code copyable>{item.errorMessage}</Typography.Text> : '—' },
        { key: 'response', label: t('responseBody'), children: item.responseBody ? <Typography.Text code copyable>{item.responseBody}</Typography.Text> : '—' },
        { key: 'event', label: t('eventIdentifier'), children: <Typography.Text code copyable>{item.eventId}</Typography.Text> },
      ]} /> }} columns={[
        { title: t('events'), dataIndex: 'eventType', width: 130, render: (value: string) => <Typography.Text>{t(eventKey(value), { defaultValue: value })}</Typography.Text> },
        { title: t('status'), dataIndex: 'status', width: 95, render: (value: string) => <StatusTag value={value} /> },
        { title: t('attempts'), dataIndex: 'attempts', width: 100, render: (value: number) => value ? t('attemptCount', { count: value }) : '—' },
        { title: t('httpStatus'), dataIndex: 'responseStatus', width: 85, render: (value?: number) => value ? <Tag color={value >= 200 && value < 300 ? 'green' : 'red'}>{value}</Tag> : '—' },
        { title: t('lastUpdated'), dataIndex: 'updatedAt', width: 150, render: (value: string, item: WebhookDelivery) => <div className="delivery-time"><Typography.Text>{formatDateTime(value, i18n.language, timezone)}</Typography.Text>{item.status === 'retrying' && <Typography.Text type="secondary">{t('nextRetry')}: {formatDateTime(item.nextAttemptAt, i18n.language, timezone)}</Typography.Text>}</div> },
        { title: t('actions'), width: 95, render: (_: unknown, item: WebhookDelivery) => item.status === 'failed' ? <Button size="small" type="link" loading={actioning === `retry:${item.id}`} onClick={() => void retryDelivery(item)}>{t('retryDelivery')}</Button> : null },
      ]} scroll={{ x: 680 }} />
    </Drawer>
  </>
}
