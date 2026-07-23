import { BellOutlined, CloudUploadOutlined, CodeOutlined, EditOutlined, GlobalOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, App, AutoComplete, Button, Card, Col, Form, Input, InputNumber, Modal, Row, Space, Switch, Typography } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBeforeUnload, useBlocker } from 'react-router-dom'
import { PageHeader } from '../components/Common'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { monitoringAlertKeys, normalizeMonitoringSettings, type MonitoringSettings } from '../lib/monitoring-settings'
import {
  defaultUploadSettings,
  GiB,
  MiB,
  normalizeUploadSettings,
  uploadSettingsFromForm,
  uploadSettingsToForm,
  type UploadSettings,
  type UploadSettingsForm,
} from '../lib/upload-settings'
import { bytes } from '../lib/types'
import { commonTimezones, defaultTimezone, isValidTimezone, normalizeTimezone } from '../lib/timezone'

type Settings = Record<string, unknown>
interface TimezoneForm { timezone: string }

export function SettingsPage() {
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { reload: reloadSystemSettings } = useSystemSettings()
  const [items, setItems] = useState<Settings>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [monitoringSaving, setMonitoringSaving] = useState(false)
  const [uploadSaving, setUploadSaving] = useState(false)
  const [timezoneSaving, setTimezoneSaving] = useState(false)
  const [monitoringDirty, setMonitoringDirty] = useState(false)
  const [uploadDirty, setUploadDirty] = useState(false)
  const [timezoneDirty, setTimezoneDirty] = useState(false)
  const [rawDirty, setRawDirty] = useState(false)
  const [uploadSettings, setUploadSettings] = useState<UploadSettings>(defaultUploadSettings)
  const [editing, setEditing] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [monitoringForm] = Form.useForm<MonitoringSettings>()
  const [uploadForm] = Form.useForm<UploadSettingsForm>()
  const [timezoneForm] = Form.useForm<TimezoneForm>()
  const monitoringBaseline = useRef<MonitoringSettings | null>(null)
  const uploadBaseline = useRef<UploadSettingsForm | null>(null)
  const timezoneBaseline = useRef<TimezoneForm | null>(null)
  const rawBaseline = useRef('')

  const load = useCallback(() => api<Settings>('/settings').then((response) => {
    setItems(response)
    setLoadError('')
    const timezoneValues = { timezone: normalizeTimezone(response.timezone) }
    const monitoringValues = normalizeMonitoringSettings(response.monitoring)
    const uploads = normalizeUploadSettings(response.uploads)
    const uploadValues = uploadSettingsToForm(uploads)
    timezoneBaseline.current = timezoneValues
    monitoringBaseline.current = monitoringValues
    uploadBaseline.current = uploadValues
    timezoneForm.setFieldsValue(timezoneValues)
    monitoringForm.setFieldsValue(monitoringValues)
    setUploadSettings(uploads)
    uploadForm.setFieldsValue(uploadValues)
    setTimezoneDirty(false)
    setMonitoringDirty(false)
    setUploadDirty(false)
  }).catch((error) => setLoadError(errorMessage(error))).finally(() => setLoading(false)), [monitoringForm, timezoneForm, uploadForm])

  useEffect(() => { void load() }, [load])

  const hasUnsavedChanges = timezoneDirty || monitoringDirty || uploadDirty || rawDirty
  const blocker = useBlocker(hasUnsavedChanges)
  useBeforeUnload(useCallback((event) => {
    if (!hasUnsavedChanges) return
    event.preventDefault()
    event.returnValue = ''
  }, [hasUnsavedChanges]))

  const show = (key: string) => {
    const value = JSON.stringify(items[key], null, 2)
    rawBaseline.current = value
    setEditing(key)
    setRaw(value)
    setRawDirty(false)
  }
  const discardRawChanges = () => { setEditing(null); setRawDirty(false) }
  const closeRawEditor = () => {
    if (saving) return
    if (!rawDirty) { discardRawChanges(); return }
    modal.confirm({
      title: t('discardSettingsChangesTitle'),
      content: t('discardSettingsChangesHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: discardRawChanges,
    })
  }
  const save = async () => {
    if (!editing) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch { message.error(t('invalidJSON')); return }
    try {
      setSaving(true)
      await api(`/settings/${editing}`, { method: 'PUT', body: parsed })
      setItems((current) => ({ ...current, [editing]: parsed }))
      rawBaseline.current = raw
      setRawDirty(false)
      message.success(t('saved'))
      setEditing(null)
    } catch (error) { message.error(errorMessage(error)) } finally { setSaving(false) }
  }
  const saveMonitoring = async () => {
    try {
      const values = await monitoringForm.validateFields()
      setMonitoringSaving(true)
      await api('/settings/monitoring', { method: 'PUT', body: values })
      monitoringBaseline.current = values
      monitoringForm.setFieldsValue(values)
      setMonitoringDirty(false)
      message.success(t('monitoringSettingsSaved'))
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally { setMonitoringSaving(false) }
  }
  const saveUploadSettings = async () => {
    try {
      const values = await uploadForm.validateFields()
      setUploadSaving(true)
      const savedUploads = uploadSettingsFromForm(values)
      await api('/settings/uploads', { method: 'PUT', body: savedUploads })
      setUploadSettings((current) => ({ ...current, ...savedUploads }))
      uploadBaseline.current = values
      uploadForm.setFieldsValue(values)
      setUploadDirty(false)
      message.success(t('uploadSettingsSaved'))
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally { setUploadSaving(false) }
  }

  const saveTimezone = async () => {
    try {
      const values = await timezoneForm.validateFields()
      const timezone = values.timezone.trim()
      setTimezoneSaving(true)
      await api('/settings/timezone', { method: 'PUT', body: JSON.stringify(timezone) })
      await reloadSystemSettings()
      const savedTimezone = { timezone }
      timezoneBaseline.current = savedTimezone
      timezoneForm.setFieldsValue(savedTimezone)
      setTimezoneDirty(false)
      message.success(t('timezoneSaved'))
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally { setTimezoneSaving(false) }
  }

  const advancedItems = Object.entries(items).filter(([key]) => key !== 'monitoring' && key !== 'uploads' && key !== 'timezone')
  const hasSettings = Object.keys(items).length > 0
  const maxAllowedGiB = uploadSettings.maxAllowedBytes / GiB
  const maxAllowedMiB = uploadSettings.maxAllowedBytes / MiB

  return <>
    <PageHeader title={t('settings')} description={t('settingsDescription')} />
    {loadError && <Alert className="instance-page-alert" type="error" showIcon message={t('settingsLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => { setLoading(true); void load() }}>{t('retry')}</Button>} />}
    {loading && !hasSettings ? <Card loading /> : hasSettings ? <Space direction="vertical" size={16} className="settings-stack">
      <Card title={<Space><GlobalOutlined />{t('timezoneSettings')}</Space>} extra={<Button type="primary" icon={<SaveOutlined />} loading={timezoneSaving} disabled={!timezoneDirty} onClick={() => void saveTimezone()}>{t('saveTimezone')}</Button>}>
        <Typography.Paragraph type="secondary">{t('timezoneSettingsHint')}</Typography.Paragraph>
        <Form form={timezoneForm} layout="vertical" requiredMark={false} initialValues={{ timezone: defaultTimezone }} onValuesChange={(_, values) => setTimezoneDirty(values.timezone !== timezoneBaseline.current?.timezone)}>
          <Form.Item name="timezone" label={t('timezone')} extra={t('timezoneHint')} rules={[{ required: true, message: t('timezoneRequired') }, { validator: (_, value) => isValidTimezone(value) ? Promise.resolve() : Promise.reject(new Error(t('timezoneInvalid'))) }]}>
            <AutoComplete className="settings-timezone-input" options={commonTimezones.map((value) => ({ value }))} filterOption={(input, option) => (option?.value ?? '').toLowerCase().includes(input.toLowerCase())} placeholder={defaultTimezone} />
          </Form.Item>
        </Form>
      </Card>
      <Card title={<Space><BellOutlined />{t('monitoringSettings')}</Space>} extra={<Button type="primary" icon={<SaveOutlined />} loading={monitoringSaving} disabled={!monitoringDirty} onClick={() => void saveMonitoring()}>{t('saveMonitoringSettings')}</Button>}>
        <Typography.Paragraph type="secondary">{t('monitoringSettingsHint')}</Typography.Paragraph>
        <Form form={monitoringForm} layout="vertical" requiredMark={false} onValuesChange={(_, values) => setMonitoringDirty(JSON.stringify(values) !== JSON.stringify(monitoringBaseline.current))}>
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
      <Card title={<Space><CloudUploadOutlined />{t('uploadSettings')}</Space>} extra={<Button type="primary" icon={<SaveOutlined />} loading={uploadSaving} disabled={!uploadDirty} onClick={() => void saveUploadSettings()}>{t('saveUploadSettings')}</Button>}>
        <Typography.Paragraph type="secondary">{t('uploadSettingsHint')}</Typography.Paragraph>
        <Form form={uploadForm} layout="vertical" requiredMark={false} onValuesChange={(_, values) => setUploadDirty(JSON.stringify(values) !== JSON.stringify(uploadBaseline.current))}>
          <Row gutter={16}>
            <Col xs={24} md={12}><Form.Item name="maxGiB" label={t('maxUploadSize')} extra={t('maxUploadSizeHint', { ceiling: bytes(uploadSettings.maxAllowedBytes) })} dependencies={['chunkMiB']} rules={[{ required: true }, { type: 'number', min: 1 / 1024, max: maxAllowedGiB, message: t('maxUploadSizeRange', { ceiling: bytes(uploadSettings.maxAllowedBytes) }) }, { validator: (_, value) => value * GiB >= uploadForm.getFieldValue('chunkMiB') * MiB ? Promise.resolve() : Promise.reject(new Error(t('uploadLimitAboveChunk'))) }]}><InputNumber min={1 / 1024} max={maxAllowedGiB} step={0.001} formatter={(value, info) => info.userTyping ? info.input : value === undefined || value === null ? '' : String(Number(value))} addonAfter="GiB" /></Form.Item></Col>
            <Col xs={24} md={12}><Form.Item name="chunkMiB" label={t('uploadChunkSize')} extra={t('uploadChunkSizeHint')} rules={[{ required: true }, { type: 'number', min: 1, max: Math.min(32, maxAllowedMiB), message: t('uploadChunkSizeRange') }]}><InputNumber min={1} max={Math.min(32, maxAllowedMiB)} precision={0} addonAfter="MiB" /></Form.Item></Col>
          </Row>
        </Form>
      </Card>
      <Row gutter={[16, 16]}>{advancedItems.map(([key, value]) => <Col xs={24} lg={12} key={key}><Card title={<Space><CodeOutlined />{key}</Space>} extra={<Button type="text" aria-label={`${t('edit')} ${key}`} icon={<EditOutlined />} onClick={() => show(key)}>{t('edit')}</Button>}><pre className="settings-json">{JSON.stringify(value, null, 2)}</pre></Card></Col>)}</Row>
      <Card className="configuration-note"><Typography.Title level={4}>{t('deploymentEnvironment')}</Typography.Title><Typography.Paragraph type="secondary">{t('deploymentEnvironmentHint')}</Typography.Paragraph></Card>
    </Space> : null}
    <Modal title={editing || t('settings')} open={!!editing} onCancel={closeRawEditor} onOk={() => void save()} confirmLoading={saving} okText={t('save')} okButtonProps={{ icon: <SaveOutlined />, disabled: !rawDirty }} width={680}><Input.TextArea aria-label={editing || t('settings')} className="json-editor" rows={18} value={raw} onChange={(event) => { setRaw(event.target.value); setRawDirty(event.target.value !== rawBaseline.current) }} spellCheck={false} /></Modal>
    <Modal title={t('unsavedSettingsTitle')} open={blocker.state === 'blocked'} onCancel={() => { if (blocker.state === 'blocked') blocker.reset() }} onOk={() => { if (blocker.state === 'blocked') blocker.proceed() }} okText={t('discardChanges')} cancelText={t('continueEditing')} okButtonProps={{ danger: true }}>
      <Typography.Paragraph>{t('unsavedSettingsHint')}</Typography.Paragraph>
    </Modal>
  </>
}
