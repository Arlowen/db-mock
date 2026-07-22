import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, ColorPicker, Form, Input, Modal, Popconfirm, Row, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { api, errorMessage } from '../lib/api'
import { permissionsFor } from '../lib/permissions'
import type { Project } from '../lib/types'

export function ProjectsPage() {
  const { t } = useTranslation(); const { message, modal } = App.useApp(); const [items, setItems] = useState<Project[]>([]); const [loading, setLoading] = useState(true); const [saving, setSaving] = useState(false); const [draftDirty, setDraftDirty] = useState(false); const [open, setOpen] = useState(false); const [editing, setEditing] = useState<Project | null>(null); const [form] = Form.useForm()
  const { user } = useAuth(); const { canOperate } = permissionsFor(user!)
  const load = useCallback(() => api<{ items: Project[] }>('/projects').then((r) => setItems(r.items)).catch((e) => message.error(errorMessage(e))).finally(() => setLoading(false)), [message])
  useEffect(() => { void load() }, [load])
  const show = (item?: Project) => { form.resetFields(); setEditing(item ?? null); setDraftDirty(false); form.setFieldsValue(item ?? { color: '#2563eb' }); setOpen(true) }
  const finishCloseEditor = () => { setOpen(false); setEditing(null); setDraftDirty(false); form.resetFields() }
  const closeEditor = () => {
    if (saving) return
    if (!draftDirty) { finishCloseEditor(); return }
    modal.confirm({
      title: t('discardProjectDraftTitle'),
      content: t('discardProjectDraftHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseEditor,
    })
  }
  const submit = async () => { try { setSaving(true); const values = await form.validateFields(); await api(editing ? `/projects/${editing.id}` : '/projects', { method: editing ? 'PUT' : 'POST', body: values }); message.success(t('saved')); finishCloseEditor(); await load() } catch (e) { if (e instanceof Error) message.error(errorMessage(e)) } finally { setSaving(false) } }
  const remove = async (item: Project) => { try { await api(`/projects/${item.id}`, { method: 'DELETE' }); await load() } catch (e) { message.error(errorMessage(e)) } }
  return <><PageHeader title={t('projects')} description={t('projectsDescription')} actions={canOperate ? <Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('create')}</Button> : undefined} />
    {items.length === 0 ? <Card loading={loading}><EmptyState action={canOperate ? () => show() : undefined} actionLabel={canOperate ? t('create') : undefined} description={t('projectsEmptyDescription')} /></Card> : <Row gutter={[16, 16]}>{items.map((item) => <Col xs={24} md={12} xl={8} key={item.id}><Card className="project-card" style={{ borderTopColor: item.color }} actions={canOperate ? [<Button key="edit" type="text" aria-label={`${t('edit')} ${item.name}`} title={t('edit')} icon={<EditOutlined />} onClick={() => show(item)} />, <Popconfirm key="delete" title={t('deleteProjectConfirm', { name: item.name })} description={t('deleteProjectHint')} okText={t('delete')} cancelText={t('cancel')} okButtonProps={{ danger: true }} onConfirm={() => void remove(item)}><Button type="text" danger aria-label={`${t('delete')} ${item.name}`} title={t('delete')} icon={<DeleteOutlined />} /></Popconfirm>] : undefined}><div className="project-card-heading"><span className="project-dot" style={{ background: item.color }} /><Typography.Title level={4}>{item.name}</Typography.Title></div><Typography.Paragraph className="project-card-description" type="secondary">{item.description || t('noDescription')}</Typography.Paragraph></Card></Col>)}</Row>}
    <Modal title={editing ? t('edit') : t('create')} open={open} onCancel={closeEditor} onOk={() => void submit()} confirmLoading={saving} closable={!saving} maskClosable={!saving} cancelButtonProps={{ disabled: saving }} okText={t('save')} destroyOnHidden><Form form={form} layout="vertical" onValuesChange={() => setDraftDirty(true)}><Form.Item name="name" label={t('name')} rules={[{ required: true }]}><Input autoFocus /></Form.Item><Form.Item name="description" label={t('description')}><Input.TextArea rows={3} /></Form.Item><Form.Item name="color" label={t('color')} getValueFromEvent={(_, hex: string) => hex}><ColorPicker format="hex" showText={(color) => color.toHexString()} /></Form.Item></Form></Modal>
  </>
}
