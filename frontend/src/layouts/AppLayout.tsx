import {
  AlertOutlined, AppstoreOutlined, AuditOutlined, BellOutlined, CloudServerOutlined, ContainerOutlined,
  DatabaseOutlined, GlobalOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ProjectOutlined,
  SettingOutlined, TeamOutlined, UnorderedListOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Button, Dropdown, Layout, Menu, Space, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const { Header, Sider, Content } = Layout

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { t, i18n } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
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
  const switchLanguage = () => {
    const locale = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN'
    void i18n.changeLanguage(locale)
    localStorage.setItem('dbmock-locale', locale)
  }
  return <Layout className="app-layout">
    <Sider width={244} collapsedWidth={72} collapsed={collapsed} className="app-sider" theme="light">
      <button className="sidebar-brand" onClick={() => navigate('/')}><span className="brand-mark small"><DatabaseOutlined /></span>{!collapsed && <span>DB Mock</span>}</button>
      <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={({ key }) => navigate(key)} />
      <div className="sider-footer"><Button type="text" block icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '' : (collapsed ? '' : 'Collapse')}</Button></div>
    </Sider>
    <Layout>
      <Header className="app-header">
        <Typography.Text type="secondary">{routeItems.find((item) => item.key === selected)?.label}</Typography.Text>
        <Space size={16}>
          <Button type="text" icon={<GlobalOutlined />} onClick={switchLanguage}>{i18n.language === 'zh-CN' ? 'EN' : '中文'}</Button>
          <Badge dot={false}><Button type="text" icon={<BellOutlined />} onClick={() => navigate('/alerts')} /></Badge>
          <Dropdown menu={{ items: [{ key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void logout() }] }}>
            <Space className="user-menu"><Avatar>{user?.displayName?.slice(0, 1).toUpperCase()}</Avatar><span className="desktop-only">{user?.displayName}</span></Space>
          </Dropdown>
        </Space>
      </Header>
      <Content className="app-content"><Outlet /></Content>
    </Layout>
  </Layout>
}
