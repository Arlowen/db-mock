import { ExperimentOutlined, PlusOutlined, SafetyOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Descriptions, Input, Modal, Segmented, Space, Tag, Typography, Upload } from 'antd'
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
  const { t, i18n } = useTranslation(); const navigate = useNavigate(); const { message } = App.useApp(); const [items, setItems] = useState<DatabaseTemplate[]>([]); const [loading, setLoading] = useState(true); const [uploading, setUploading] = useState(false); const [search, setSearch] = useState(''); const [tier, setTier] = useState('all'); const [uploadOpen, setUploadOpen] = useState(false); const [file, setFile] = useState<UploadFile | null>(null); const [details, setDetails] = useState<DatabaseTemplate | null>(null)
  const load = useCallback(() => api<{ items: DatabaseTemplate[] }>('/templates').then((r) => setItems(r.items)).catch((e) => message.error(errorMessage(e))).finally(() => setLoading(false)), [message]); useEffect(() => { void load() }, [load])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return items.filter((item) => {
      if (tier !== 'all' && item.tier !== tier) return false
      if (!query) return true
      const categoryKey = `category_${item.category.replaceAll('-', '_')}`
      const descriptionKey = `templateDescription_${item.slug}`
      const versionTerms = item.versions.flatMap((version) => [version.version, `v${version.version}`, version.imageReference, String(version.defaultPort), ...version.architectures])
      return [item.name, item.nameZh, item.slug, item.category, item.description, t(categoryKey, { defaultValue: item.category }), t(descriptionKey, { defaultValue: item.description }), ...versionTerms].filter(Boolean).join(' ').toLowerCase().includes(query)
    })
  }, [i18n.language, items, search, t, tier])
  const customEmpty = tier === 'custom' && search.trim() === '' && filtered.length === 0
  const showUpload = () => { setFile(null); setUploadOpen(true) }
  const upload = async () => { const raw = file?.originFileObj; if (!raw) return; const form = new FormData(); form.append('package', raw); try { setUploading(true); await api('/templates/custom', { method: 'POST', body: form }); message.success(t('templateUploaded')); setUploadOpen(false); setFile(null); setSearch(''); setTier('custom'); await load() } catch (e) { message.error(errorMessage(e)) } finally { setUploading(false) } }
  const resetFilters = () => { setSearch(''); setTier('all') }
  return <><PageHeader title={t('catalog')} description={t('catalogDescription')} actions={<Button icon={<UploadOutlined />} onClick={showUpload}>{t('uploadTemplate')}</Button>} />
    <Card className="catalog-toolbar"><Space wrap><Input.Search aria-label={t('catalogSearchLabel')} allowClear value={search} placeholder={t('catalogSearchPlaceholder')} style={{ width: 320 }} onChange={(e) => setSearch(e.target.value)} /><Segmented value={tier} onChange={(v) => setTier(String(v))} options={[{ value: 'all', label: t('all') }, { value: 'standard', label: t('standard') }, { value: 'experimental', label: t('experimental') }, { value: 'custom', label: t('custom') }]} /></Space></Card>
    {loading && <Card loading />}
    {!loading && filtered.length === 0 && <Card><EmptyState action={customEmpty ? showUpload : resetFilters} actionLabel={t(customEmpty ? 'uploadTemplate' : 'clearFilters')} description={t(customEmpty ? 'customCatalogEmptyDescription' : 'catalogEmptyDescription')} /></Card>}
    {!loading && filtered.length > 0 && <div className="catalog-grid">{filtered.map((item) => {
      const version = item.versions[0]
      const displayName = i18n.language === 'zh-CN' ? item.nameZh || item.name : item.name
      return <Card key={item.id} className="template-card" actions={[<Button key="create" type="link" icon={<PlusOutlined />} onClick={() => navigate(`/instances?create=1&template=${version?.id}`)}>{t('create')}</Button>, <Button key="details" type="link" onClick={() => setDetails(item)}>{t('details')}</Button>]}>
        <div className="template-card-main">
          <div className="template-card-header">
            <DatabaseIcon slug={item.slug} name={displayName} />
            <div className="template-card-heading">
              <Typography.Title level={4} className="template-card-title">{displayName}</Typography.Title>
              <span className="template-card-tier"><StatusTag value={item.tier} /></span>
            </div>
          </div>
          <Typography.Paragraph className="template-card-description" type="secondary" ellipsis={{ rows: 2 }}>{t(`templateDescription_${item.slug}`, { defaultValue: item.description })}</Typography.Paragraph>
          <Space className="template-card-tags"><Tag>{t(`category_${item.category.replaceAll('-', '_')}`, { defaultValue: item.category })}</Tag>{version?.architectures.map((arch) => <Tag key={arch}>{arch}</Tag>)}</Space>
        </div>
        {version && <div className="template-meta"><span>v{version.version}</span><span>{version.minCpu} CPU</span><span>{bytes(version.minMemoryBytes)}</span><span>{bytes(version.minDiskBytes)}</span></div>}
      </Card>
    })}</div>}
    <Modal title={t('uploadTemplate')} open={uploadOpen} onCancel={() => { if (!uploading) setUploadOpen(false) }} onOk={() => void upload()} confirmLoading={uploading} okText={t('uploadTemplate')} okButtonProps={{ disabled: !file }}><Typography.Paragraph type="secondary">{t('uploadTemplateHint')}</Typography.Paragraph><Upload.Dragger accept=".zip" maxCount={1} beforeUpload={() => false} fileList={file ? [file] : []} disabled={uploading} onChange={({ fileList }) => setFile(fileList.at(-1) ?? null)}><p className="ant-upload-drag-icon"><UploadOutlined /></p><p>{t('dropTemplatePackage')}</p></Upload.Dragger></Modal>
    <TemplateDetailsModal template={details} onClose={() => setDetails(null)} onCreate={(versionID) => { setDetails(null); navigate(`/instances?create=1&template=${versionID}`) }} />
  </>
}

function TemplateDetailsModal({ template, onClose, onCreate }: { template: DatabaseTemplate | null; onClose: () => void; onCreate: (versionID: string) => void }) {
  const { t, i18n } = useTranslation()
  const version = template?.versions[0]
  const displayName = template ? i18n.language === 'zh-CN' ? template.nameZh || template.name : template.name : ''

  return <Modal
    className="template-detail-modal"
    title={t('templateDetails')}
    open={!!template}
    width={720}
    destroyOnHidden
    onCancel={onClose}
    footer={<><Button onClick={onClose}>{t('close')}</Button><Button type="primary" icon={<PlusOutlined />} disabled={!version} onClick={() => version && onCreate(version.id)}>{t('createInstance')}</Button></>}
  >
    {template && <div className="template-detail">
      <div className="template-detail-summary">
        <DatabaseIcon slug={template.slug} name={displayName} />
        <div>
          <Space wrap size={[8, 6]}><Typography.Title level={4}>{displayName}</Typography.Title><StatusTag value={template.tier} /><Tag>{t(`category_${template.category.replaceAll('-', '_')}`, { defaultValue: template.category })}</Tag></Space>
          <Typography.Paragraph type="secondary">{t(`templateDescription_${template.slug}`, { defaultValue: template.description })}</Typography.Paragraph>
        </div>
      </div>
      {version && <Descriptions className="template-detail-facts" bordered size="small" column={1} items={[
        { key: 'version', label: t('version'), children: <Typography.Text strong>v{version.version}</Typography.Text> },
        { key: 'port', label: t('containerPort'), children: <Typography.Text code>{version.defaultPort}</Typography.Text> },
        { key: 'image', label: t('imageReference'), children: <Typography.Text code copyable={{ text: version.imageReference }}>{version.imageReference}</Typography.Text> },
        { key: 'architectures', label: t('architecture'), children: <Space wrap size={[4, 4]}>{version.architectures.map((arch) => <Tag key={arch}>{arch}</Tag>)}</Space> },
        { key: 'resources', label: t('minimumResources'), children: `${version.minCpu} CPU · ${bytes(version.minMemoryBytes)} ${t('memory')} · ${bytes(version.minDiskBytes)} ${t('disk')}` },
      ]} />}
      <div className="template-risk-section">
        <Typography.Text className="form-section-label">{t('composeSafety')}</Typography.Text>
        {template.riskReport?.length ? <Space direction="vertical" size={10} style={{ width: '100%' }}>{template.riskReport.map((item) => <Card size="small" key={item.code}><Space align="start"><WarningOutlined style={{ color: item.severity === 'critical' ? '#cf1322' : '#d48806' }} /><div><Typography.Text strong>{t(item.severity)}</Typography.Text><br /><Typography.Text type="secondary">{t(`risk_${item.code}`, { defaultValue: item.message })}</Typography.Text></div></Space></Card>)}</Space> : <Alert type="success" showIcon icon={template.tier === 'experimental' ? <ExperimentOutlined /> : <SafetyOutlined />} message={t('composeSafetyClear')} description={t('noComposeRisks')} />}
      </div>
    </div>}
  </Modal>
}
