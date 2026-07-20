import { BellOutlined, CodeOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Space, Switch, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import { monitoringAlertKeys, normalizeMonitoringSettings, type MonitoringSettings } from '../lib/monitoring-settings'

type Settings = Record<string, unknown>

export function SettingsPage() {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const [items, setItems] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [monitoringSaving, setMonitoringSaving] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [monitoringForm] = Form.useForm<MonitoringSettings>()

  const load = useCallback(() => api<Settings>('/settings').then((response) => {
    setItems(response)
    monitoringForm.setFieldsValue(normalizeMonitoringSettings(response.monitoring))
  }).catch((error) => message.error(errorMessage(error))).finally(() => setLoading(false)), [message, monitoringForm])

  useEffect(() => { void load() }, [load])

  const show = (key: string) => { setEditing(key); setRaw(JSON.stringify(items[key], null, 2)) }
  const save = async () => {
    if (!editing) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { message.error(t('invalidJSON')); return }
    try {
      setSaving(true)
      await api(`/settings/${editing}`, { method: 'PUT', body: parsed })
      message.success(t('saved'))
      setEditing(null)
      await load()
    } catch (error) { message.error(errorMessage(error)) } finally { setSaving(false) }
  }
  const saveMonitoring = async () => {
    try {
      const values = await monitoringForm.validateFields()
      setMonitoringSaving(true)
      await api('/settings/monitoring', { method: 'PUT', body: values })
      message.success(t('monitoringSettingsSaved'))
      await load()
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally { setMonitoringSaving(false) }
  }

  const advancedItems = Object.entries(items).filter(([key]) => key !== 'monitoring')

  return <>
    <PageHeader title={t('settings')} description={t('settingsDescription')} />
    {loading ? <Card loading /> : <Space direction="vertical" size={16} className="settings-stack">
      <Card title={<Space><BellOutlined />{t('monitoringSettings')}</Space>} extra={<Button type="primary" icon={<SaveOutlined />} loading={monitoringSaving} onClick={() => void saveMonitoring()}>{t('saveMonitoringSettings')}</Button>}>
        <Typography.Paragraph type="secondary">{t('monitoringSettingsHint')}</Typography.Paragraph>
        <Form form={monitoringForm} layout="vertical" requiredMark={false}>
          <Typography.Title level={5}>{t('collectionPolicy')}</Typography.Title>
          <Row gutter={16}>
            <Col xs={24} md={12} xl={6}><Form.Item name="intervalSeconds" label={t('monitoringInterval')} extra={t('monitoringIntervalHint')} rules={[{ required: true }, { type: 'number', min: 5, max: 3600, message: t('monitoringIntervalHint') }]}><InputNumber min={5} max={3600} precision={0} addonAfter={t('seconds')} /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="retentionDays" label={t('metricRetention')} extra={t('metricRetentionHint')} rules={[{ required: true }, { type: 'number', min: 1, max: 365, message: t('metricRetentionHint') }]}><InputNumber min={1} max={365} precision={0} addonAfter={t('days')} /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="diskWarningPercent" label={t('diskWarningThreshold')} extra={t('diskWarningThresholdHint')} rules={[{ required: true }, { type: 'number', min: 1, max: 99, message: t('diskWarningThresholdRange') }]}><InputNumber min={1} max={99} addonAfter="%" /></Form.Item></Col>
            <Col xs={24} md={12} xl={6}><Form.Item name="diskCriticalPercent" label={t('diskCriticalThreshold')} extra={t('diskCriticalThresholdHint')} dependencies={['diskWarningPercent']} rules={[{ required: true }, { type: 'number', min: 2, max: 100, message: t('diskCriticalThresholdRange') }, { validator: (_, value) => value > monitoringForm.getFieldValue('diskWarningPercent') ? Promise.resolve() : Promise.reject(new Error(t('diskCriticalAboveWarning'))) }]}><InputNumber min={2} max={100} addonAfter="%" /></Form.Item></Col>
          </Row>
          <Typography.Title level={5}>{t('alertPolicy')}</Typography.Title>
          <Typography.Paragraph type="secondary">{t('alertPolicyHint')}</Typography.Paragraph>
          <div className="monitoring-alert-grid">
            {monitoringAlertKeys.map((key) => <div className="monitoring-alert-option" key={key}><div><Typography.Text strong>{t(`monitoringAlert_${key}`)}</Typography.Text><Typography.Paragraph type="secondary">{t(`monitoringAlertHint_${key}`)}</Typography.Paragraph></div><Form.Item name={['alerts', key]} valuePropName="checked" noStyle><Switch aria-label={t(`monitoringAlert_${key}`)} /></Form.Item></div>)}
          </div>
        </Form>
      </Card>
      <Row gutter={[16, 16]}>{advancedItems.map(([key, value]) => <Col xs={24} lg={12} key={key}><Card title={<Space><CodeOutlined />{key}</Space>} extra={<Button type="text" aria-label={`${t('edit')} ${key}`} icon={<EditOutlined />} onClick={() => show(key)}>{t('edit')}</Button>}><pre className="settings-json">{JSON.stringify(value, null, 2)}</pre></Card></Col>)}</Row>
      <Card className="configuration-note"><Typography.Title level={4}>{t('deploymentEnvironment')}</Typography.Title><Typography.Paragraph type="secondary">{t('deploymentEnvironmentHint')}</Typography.Paragraph></Card>
    </Space>}
    <Modal title={editing || t('settings')} open={!!editing} onCancel={() => setEditing(null)} onOk={() => void save()} confirmLoading={saving} okText={t('save')} okButtonProps={{ icon: <SaveOutlined /> }} width={680}><Input.TextArea aria-label={editing || t('settings')} className="json-editor" rows={18} value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} /></Modal>
  </>
}
