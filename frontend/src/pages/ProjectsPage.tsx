import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, Form, Input, Modal, Popconfirm, Row, Space, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader } from '../components/Common'
import { api, errorMessage } from '../lib/api'
import type { Project } from '../lib/types'

export function ProjectsPage() {
  const { t } = useTranslation(); const { message } = App.useApp(); const [items, setItems] = useState<Project[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<Project | null>(null); const [form] = Form.useForm()
  const load = useCallback(() => api<{ items: Project[] }>('/projects').then((r) => setItems(r.items)).catch((e) => message.error(errorMessage(e))).finally(() => setLoading(false)), [message])
  useEffect(() => { void load() }, [load])
  const show = (item?: Project) => { form.resetFields(); setEditing(item ?? null); form.setFieldsValue(item ?? { color: '#2563eb' }); setOpen(true) }
  const submit = async () => { try { setSaving(true); const values = await form.validateFields(); await api(editing ? `/projects/${editing.id}` : '/projects', { method: editing ? 'PUT' : 'POST', body: values }); message.success(t('saved')); setOpen(false); form.resetFields(); await load() } catch (e) { if (e instanceof Error) message.error(errorMessage(e)) } finally { setSaving(false) } }
  const remove = async (item: Project) => { try { await api(`/projects/${item.id}`, { method: 'DELETE' }); await load() } catch (e) { message.error(errorMessage(e)) } }
  return <><PageHeader title={t('projects')} description={t('projectsDescription')} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('create')}</Button>} />
    {items.length === 0 ? <Card loading={loading}><EmptyState action={() => show()} actionLabel={t('create')} description={t('projectsEmptyDescription')} /></Card> : <Row gutter={[16, 16]}>{items.map((item) => <Col xs={24} md={12} xl={8} key={item.id}><Card className="project-card" actions={[<Button key="edit" type="text" aria-label={`${t('edit')} ${item.name}`} title={t('edit')} icon={<EditOutlined />} onClick={() => show(item)} />, <Popconfirm key="delete" title={t('delete')} description={t('projectDeleteBlocked')} onConfirm={() => void remove(item)}><Button type="text" danger aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} /></Popconfirm>]}><Space direction="vertical"><Space><span className="project-dot" style={{ background: item.color }} /><Typography.Title level={4}>{item.name}</Typography.Title></Space><Typography.Paragraph type="secondary">{item.description || t('noDescription')}</Typography.Paragraph></Space></Card></Col>)}</Row>}
    <Modal title={editing ? t('edit') : t('create')} open={open} onCancel={() => setOpen(false)} onOk={() => void submit()} confirmLoading={saving} okText={t('save')} destroyOnHidden><Form form={form} layout="vertical"><Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="description" label={t('description')}><Input.TextArea rows={3} /></Form.Item><Form.Item name="color" label={t('color')}><Input type="color" /></Form.Item></Form></Modal>
  </>
}
