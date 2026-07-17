import { AlertOutlined, CloudServerOutlined, ContainerOutlined, FieldTimeOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons'
import { App, Button, Card, Col, List, Row, Space, Statistic, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { PageHeader, StatusTag } from '../components/Common'
import { DatabaseIcon } from '../components/DatabaseIcon'
import { api, errorMessage } from '../lib/api'
import { translateCode } from '../lib/localization'
import type { Alert, Instance, Task } from '../lib/types'

interface Dashboard { hosts: Record<string, number>; instances: Record<string, number>; activeTasks: number; openAlerts: number; users: number; projects: number }

export function DashboardPage() {
  const { t } = useTranslation(); const navigate = useNavigate(); const { message } = App.useApp()
  const [data, setData] = useState<Dashboard>({ hosts: {}, instances: {}, activeTasks: 0, openAlerts: 0, users: 0, projects: 0 })
  const [instances, setInstances] = useState<Instance[]>([]); const [tasks, setTasks] = useState<Task[]>([]); const [alerts, setAlerts] = useState<Alert[]>([])
  useEffect(() => { void Promise.all([api<Dashboard>('/dashboard'), api<{ items: Instance[] }>('/instances'), api<{ items: Task[] }>('/tasks'), api<{ items: Alert[] }>('/alerts?status=open')]).then(([d, i, ta, a]) => { setData(d); setInstances(i.items.slice(0, 5)); setTasks(ta.items.slice(0, 5)); setAlerts(a.items.slice(0, 5)) }).catch((e) => message.error(errorMessage(e))) }, [message])
  const cards = [
    { title: t('hosts'), value: Object.values(data.hosts).reduce((a, b) => a + b, 0), suffix: `${data.hosts.online ?? 0} ${t('online')}`, icon: <CloudServerOutlined />, color: '#1677ff' },
    { title: t('instances'), value: Object.values(data.instances).reduce((a, b) => a + b, 0), suffix: `${data.instances.running ?? 0} ${t('running')}`, icon: <ContainerOutlined />, color: '#13a8a8' },
    { title: t('tasks'), value: data.activeTasks, suffix: t('running'), icon: <FieldTimeOutlined />, color: '#722ed1' },
    { title: t('alerts'), value: data.openAlerts, suffix: t('open'), icon: <AlertOutlined />, color: '#fa8c16' },
  ]
  return <><PageHeader title={t('dashboard')} description={t('dashboardDescription')} actions={<Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/instances?create=1')}>{t('createInstance')}</Button>} />
    <Row gutter={[16, 16]}>{cards.map((card) => <Col xs={24} sm={12} xl={6} key={card.title}><Card className="stat-card"><Space align="start"><span className="stat-icon" style={{ color: card.color, background: `${card.color}14` }}>{card.icon}</span><Statistic title={card.title} value={card.value} suffix={<Typography.Text type="secondary" className="stat-suffix">{card.suffix}</Typography.Text>} /></Space></Card></Col>)}</Row>
    <Row gutter={[16, 16]} className="dashboard-grid"><Col xs={24} xl={12}><Card title={t('instances')} extra={<Button type="link" onClick={() => navigate('/instances')}>{t('viewAll')}</Button>}><List dataSource={instances} locale={{ emptyText: t('noData') }} renderItem={(item) => <List.Item onClick={() => navigate(`/instances/${item.id}`)} className="clickable-list"><List.Item.Meta avatar={<DatabaseIcon slug={item.templateSlug} name={item.templateName} size="small" />} title={item.name} description={`${item.templateName} ${item.templateVersion} · ${item.hostName}`} /><StatusTag value={item.status} /></List.Item>} /></Card></Col>
    <Col xs={24} xl={12}><Card title={t('tasks')}><List dataSource={tasks} locale={{ emptyText: t('noData') }} renderItem={(item) => <List.Item onClick={() => navigate('/tasks')} className="clickable-list"><List.Item.Meta title={translateCode(t, item.kind, 'taskKind')} description={item.message ? translateCode(t, item.message, 'taskMessage') : translateCode(t, item.stage)} /><StatusTag value={item.status} /></List.Item>} /></Card></Col>
    <Col xs={24}><Card title={t('alerts')}><List grid={{ gutter: 16, xs: 1, md: 2 }} dataSource={alerts} locale={{ emptyText: t('noData') }} renderItem={(item) => <List.Item><Card size="small"><Space direction="vertical"><Space><AlertOutlined /><Typography.Text strong>{t(`alertTitle_${item.type}`, { defaultValue: item.title })}</Typography.Text><StatusTag value={item.severity} /></Space><Typography.Text type="secondary">{item.message}</Typography.Text></Space></Card></List.Item>} /></Card></Col></Row>
  </>
}
