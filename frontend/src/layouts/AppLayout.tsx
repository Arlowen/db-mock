import {
  AlertOutlined, AppstoreOutlined, AuditOutlined, BellOutlined, CloudServerOutlined, ContainerOutlined,
  DatabaseOutlined, DownOutlined, GlobalOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ProjectOutlined,
  SettingOutlined, TeamOutlined, UnorderedListOutlined,
} from '@ant-design/icons'
import { App, Avatar, Badge, Button, Dropdown, Layout, Menu, Space, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { api, errorMessage } from '../lib/api'
import { oppositeLocale } from '../lib/locale'
import type { Alert } from '../lib/types'

const { Header, Sider, Content } = Layout

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { t, i18n } = useTranslation()
  const { message } = App.useApp()
  const { user, logout, updateLocale } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [activeAlerts, setActiveAlerts] = useState(0)
  const [languageSaving, setLanguageSaving] = useState(false)
  useEffect(() => {
    let active = true
    const loadAlerts = () => void api<{ items: Alert[] }>('/alerts').then((response) => {
      if (active) setActiveAlerts(response.items.filter((item) => item.status !== 'resolved').length)
    }).catch(() => undefined)
    loadAlerts()
    const timer = window.setInterval(loadAlerts, 30000)
    return () => { active = false; window.clearInterval(timer) }
  }, [location.pathname])
  const routeItems = [
    { key: '/', icon: <AppstoreOutlined />, label: t('dashboard') },
    { key: '/projects', icon: <ProjectOutlined />, label: t('projects') },
    { key: '/hosts', icon: <CloudServerOutlined />, label: t('hosts') },
    { key: '/catalog', icon: <DatabaseOutlined />, label: t('catalog') },
    { key: '/instances', icon: <ContainerOutlined />, label: t('instances') },
    { key: '/images', icon: <UnorderedListOutlined />, label: t('images') },
    { key: '/tasks', icon: <AuditOutlined />, label: t('tasks') },
    { key: '/alerts', icon: <AlertOutlined />, label: t('alerts') },
    { key: '/users', icon: <TeamOutlined />, label: t('users') },
    { key: '/audit', icon: <AuditOutlined />, label: t('audit') },
    { key: '/settings', icon: <SettingOutlined />, label: t('settings') },
  ]
  const items: MenuProps['items'] = [
    routeItems[0],
    { type: 'group', label: t('navResources'), children: [routeItems[1], routeItems[2]] },
    { type: 'group', label: t('navDatabases'), children: [routeItems[3], routeItems[4], routeItems[5]] },
    { type: 'group', label: t('navOperations'), children: [routeItems[6], routeItems[7], routeItems[9]] },
    { type: 'group', label: t('navSystem'), children: [routeItems[8], routeItems[10]] },
  ]
  const selected = routeItems.find((item) => item.key !== '/' && location.pathname.startsWith(item.key))?.key ?? '/'
  const targetLocale = oppositeLocale(i18n.language)
  const switchLanguage = async () => {
    try {
      setLanguageSaving(true)
      await updateLocale(targetLocale)
    } catch (error) {
      message.error(errorMessage(error))
    } finally {
      setLanguageSaving(false)
    }
  }
  return <><a className="skip-link" href="#main-content">{t('skipToContent')}</a><Layout className="app-layout">
    <Sider width={244} collapsedWidth={72} collapsed={collapsed} className="app-sider" theme="light">
      <button className="sidebar-brand" aria-label={t('dashboard')} onClick={() => navigate('/')}><span className="brand-mark small"><DatabaseOutlined /></span>{!collapsed && <span>DB Mock</span>}</button>
      <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={({ key }) => navigate(key)} />
      <div className="sider-footer"><Button type="text" block aria-label={collapsed ? t('expandMenu') : t('collapse')} title={collapsed ? t('expandMenu') : t('collapse')} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '' : t('collapse')}</Button></div>
    </Sider>
    <Layout>
      <Header className="app-header">
        <Typography.Text type="secondary">{routeItems.find((item) => item.key === selected)?.label}</Typography.Text>
        <Space size={16}>
          <Button type="text" icon={<GlobalOutlined />} loading={languageSaving} aria-label={t(targetLocale === 'en-US' ? 'switchToEnglish' : 'switchToChinese')} onClick={() => void switchLanguage()}>{targetLocale === 'en-US' ? t('languageEnglish') : t('languageChinese')}</Button>
          <Badge count={activeAlerts} size="small" overflowCount={99}><Button type="text" aria-label={t('alerts')} title={t('alerts')} icon={<BellOutlined />} onClick={() => navigate('/alerts')} /></Badge>
          <Dropdown menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void logout() }] }}>
            <Button type="text" className="user-menu" aria-label={t('accountMenu')}><Avatar size={30}>{user?.displayName?.slice(0, 1).toUpperCase()}</Avatar><span className="desktop-only">{user?.displayName}</span><DownOutlined className="user-menu-caret" /></Button>
          </Dropdown>
        </Space>
      </Header>
      <Content id="main-content" tabIndex={-1} className="app-content"><Outlet /></Content>
    </Layout>
  </Layout></>
}
