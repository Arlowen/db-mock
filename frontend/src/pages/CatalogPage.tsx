import { ExperimentOutlined, PlusOutlined, SafetyOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons'
import { App, Button, Card, Input, Modal, Segmented, Space, Tag, Typography, Upload } from 'antd'
import type { UploadFile } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { EmptyState, PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import { api, errorMessage } from '../lib/api'
import type { DatabaseTemplate } from '../lib/types'
import { bytes } from '../lib/types'

export function CatalogPage() {
  const { t, i18n } = useTranslation(); const navigate = useNavigate(); const { message } = App.useApp(); const [items, setItems] = useState<DatabaseTemplate[]>([]); const [loading, setLoading] = useState(true); const [uploading, setUploading] = useState(false); const [search, setSearch] = useState(''); const [tier, setTier] = useState('all'); const [uploadOpen, setUploadOpen] = useState(false); const [file, setFile] = useState<UploadFile | null>(null); const [risk, setRisk] = useState<DatabaseTemplate | null>(null)
  const load = useCallback(() => api<{ items: DatabaseTemplate[] }>('/templates').then((r) => setItems(r.items)).catch((e) => message.error(errorMessage(e))).finally(() => setLoading(false)), [message]); useEffect(() => { void load() }, [load])
  const filtered = useMemo(() => items.filter((item) => (tier === 'all' || item.tier === tier) && `${item.name} ${item.nameZh} ${item.category}`.toLowerCase().includes(search.toLowerCase())), [items, search, tier])
  const showUpload = () => { setFile(null); setUploadOpen(true) }
  const upload = async () => { const raw = file?.originFileObj; if (!raw) return; const form = new FormData(); form.append('package', raw); try { setUploading(true); await api('/templates/custom', { method: 'POST', body: form }); message.success(t('uploadTemplate')); setUploadOpen(false); setFile(null); await load() } catch (e) { message.error(errorMessage(e)) } finally { setUploading(false) } }
  const resetFilters = () => { setSearch(''); setTier('all') }
  return <><PageHeader title={t('catalog')} description={t('catalogDescription')} actions={<Button icon={<UploadOutlined />} onClick={showUpload}>{t('uploadTemplate')}</Button>} />
    <Card className="catalog-toolbar"><Space wrap><Input.Search allowClear value={search} placeholder={t('search')} style={{ width: 320 }} onChange={(e) => setSearch(e.target.value)} /><Segmented value={tier} onChange={(v) => setTier(String(v))} options={[{ value: 'all', label: t('all') }, { value: 'standard', label: t('standard') }, { value: 'experimental', label: t('experimental') }, { value: 'custom', label: t('custom') }]} /></Space></Card>
    {loading && <Card loading />}
    {!loading && filtered.length === 0 && <Card><EmptyState action={resetFilters} actionLabel={t('clearFilters')} description={t('catalogEmptyDescription')} /></Card>}
    {!loading && filtered.length > 0 && <div className="catalog-grid">{filtered.map((item) => {
      const version = item.versions[0]
      const displayName = i18n.language === 'zh-CN' ? item.nameZh || item.name : item.name
      return <Card key={item.id} className="template-card" actions={[<Button key="create" type="link" icon={<PlusOutlined />} onClick={() => navigate(`/instances?create=1&template=${version?.id}`)}>{t('create')}</Button>, <Button key="risk" type="link" onClick={() => setRisk(item)}>{t('details')}</Button>]}>
        <div className="template-card-main">
          <div className="template-card-header">
            <DatabaseIcon slug={item.slug} name={displayName} />
            <Typography.Title level={4} className="template-card-title">{displayName}</Typography.Title>
            <StatusTag value={item.tier} />
          </div>
          <Typography.Paragraph className="template-card-description" type="secondary" ellipsis={{ rows: 2 }}>{t(`templateDescription_${item.slug}`, { defaultValue: item.description })}</Typography.Paragraph>
          <Space className="template-card-tags"><Tag>{t(`category_${item.category.replaceAll('-', '_')}`, { defaultValue: item.category })}</Tag>{version?.architectures.map((arch) => <Tag key={arch}>{arch}</Tag>)}</Space>
        </div>
        {version && <div className="template-meta"><span>v{version.version}</span><span>{version.minCpu} CPU</span><span>{bytes(version.minMemoryBytes)}</span><span>{bytes(version.minDiskBytes)}</span></div>}
      </Card>
    })}</div>}
    <Modal title={t('uploadTemplate')} open={uploadOpen} onCancel={() => { if (!uploading) setUploadOpen(false) }} onOk={() => void upload()} confirmLoading={uploading} okText={t('uploadTemplate')} okButtonProps={{ disabled: !file }}><Typography.Paragraph type="secondary">{t('uploadTemplateHint')}</Typography.Paragraph><Upload.Dragger accept=".zip" maxCount={1} beforeUpload={() => false} fileList={file ? [file] : []} disabled={uploading} onChange={({ fileList }) => setFile(fileList.at(-1) ?? null)}><p className="ant-upload-drag-icon"><UploadOutlined /></p><p>{t('dropTemplatePackage')}</p></Upload.Dragger></Modal>
    <Modal title={risk?.name} open={!!risk} onCancel={() => setRisk(null)} footer={<Button onClick={() => setRisk(null)}>{t('confirm')}</Button>}><Space direction="vertical" style={{ width: '100%' }}><Space>{risk?.tier === 'experimental' ? <ExperimentOutlined /> : <SafetyOutlined />}<StatusTag value={risk?.tier ?? ''} /></Space>{risk?.riskReport?.length ? risk.riskReport.map((item) => <Card size="small" key={item.code}><Space align="start"><WarningOutlined style={{ color: item.severity === 'critical' ? '#cf1322' : '#d48806' }} /><div><Typography.Text strong>{item.code}</Typography.Text><br /><Typography.Text type="secondary">{t(`risk_${item.code}`, { defaultValue: item.message })}</Typography.Text></div></Space></Card>) : <Typography.Text type="secondary">{t('noComposeRisks')}</Typography.Text>}</Space></Modal>
  </>
}
