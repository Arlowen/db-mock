import { CodeOutlined, EditOutlined, SaveOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, Input, Modal, Row, Space, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'

type Settings = Record<string, unknown>

export function SettingsPage() {
  const { t } = useTranslation(); const { message } = App.useApp(); const [items, setItems] = useState<Settings>({}); const [editing, setEditing] = useState<string | null>(null); const [raw, setRaw] = useState('')
  const load = useCallback(() => api<Settings>('/settings').then(setItems).catch((error) => message.error(errorMessage(error))), [message])
  useEffect(() => { void load() }, [load])
  const show = (key: string) => { setEditing(key); setRaw(JSON.stringify(items[key], null, 2)) }
  const save = async () => { if (!editing) return; try { const parsed = JSON.parse(raw); await api(`/settings/${editing}`, { method: 'PUT', body: parsed }); message.success(t('save')); setEditing(null); await load() } catch (error) { message.error(errorMessage(error)) } }
  return <><PageHeader title={t('settings')} description={t('settingsDescription')} /><Row gutter={[16, 16]}>{Object.entries(items).map(([key, value]) => <Col xs={24} lg={12} key={key}><Card title={<Space><CodeOutlined />{key}</Space>} extra={<Button type="text" icon={<EditOutlined />} onClick={() => show(key)}>{t('edit')}</Button>}><pre className="settings-json">{JSON.stringify(value, null, 2)}</pre></Card></Col>)}</Row>
    <Card className="configuration-note"><Typography.Title level={4}>{t('deploymentEnvironment')}</Typography.Title><Typography.Paragraph type="secondary">{t('deploymentEnvironmentHint')}</Typography.Paragraph></Card>
    <Modal title={editing || t('settings')} open={!!editing} onCancel={() => setEditing(null)} onOk={() => void save()} okText={t('save')} okButtonProps={{ icon: <SaveOutlined /> }} width={680}><Input.TextArea className="json-editor" rows={18} value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} /></Modal>
  </>
}
