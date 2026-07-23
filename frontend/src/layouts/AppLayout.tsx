import {
  AlertOutlined, AppstoreOutlined, AuditOutlined, BellOutlined, CloudServerOutlined, ContainerOutlined,
  DatabaseOutlined, DownOutlined, GlobalOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, ProjectOutlined,
  SettingOutlined, TeamOutlined, UnorderedListOutlined, UserOutlined,
} from '@ant-design/icons'
import { Alert, App, Avatar, Badge, Button, Divider, Dropdown, Form, Input, Layout, Menu, Modal, Select, Space, Tag, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BrandLogo } from '../components/BrandLogo'
import { useAuth } from '../contexts/AuthContext'
import { api, errorMessage } from '../lib/api'
import { oppositeLocale } from '../lib/locale'
import { permissionsFor } from '../lib/permissions'
import type { Alert as AlertItem } from '../lib/types'

const { Header, Sider, Content } = Layout

interface AccountProfileForm { displayName: string; locale: 'zh-CN' | 'en-US' }
interface AccountPasswordForm { currentPassword: string; newPassword: string; confirmPassword: string }

export function AppLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { t, i18n } = useTranslation()
  const { message } = App.useApp()
  const { user, logout, updateLocale, updateProfile, changePassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [activeAlerts, setActiveAlerts] = useState(0)
  const [languageSaving, setLanguageSaving] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [profileSaving, setProfileSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [profileForm] = Form.useForm<AccountProfileForm>()
  const [passwordForm] = Form.useForm<AccountPasswordForm>()
  const permissions = permissionsFor(user!)
  useEffect(() => {
    let active = true
    const loadAlerts = () => void api<{ items: AlertItem[] }>('/alerts').then((response) => {
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
  const operationalItems = [routeItems[6], routeItems[7], ...(permissions.canViewAudit ? [routeItems[9]] : [])]
  const systemItems = [...(permissions.canManageUsers ? [routeItems[8]] : []), ...(permissions.canManageSettings ? [routeItems[10]] : [])]
  const items: MenuProps['items'] = [
    routeItems[0],
    { type: 'group', label: t('navResources'), children: [routeItems[1], routeItems[2]] },
    { type: 'group', label: t('navDatabases'), children: [routeItems[3], routeItems[4], routeItems[5]] },
    { type: 'group', label: t('navOperations'), children: operationalItems },
  ]
  if (systemItems.length) items.push({ type: 'group', label: t('navSystem'), children: systemItems })
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
  const openAccount = () => {
    profileForm.setFieldsValue({ displayName: user?.displayName || '', locale: user?.locale === 'en-US' ? 'en-US' : 'zh-CN' })
    passwordForm.resetFields()
    setAccountOpen(true)
  }
  const closeAccount = () => {
    if (profileSaving || passwordSaving) return
    setAccountOpen(false)
    passwordForm.resetFields()
  }
  const saveProfile = async () => {
    try {
      setProfileSaving(true)
      const values = await profileForm.validateFields()
      await updateProfile(values)
      message.success(t('profileSaved'))
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally {
      setProfileSaving(false)
    }
  }
  const savePassword = async () => {
    try {
      setPasswordSaving(true)
      const values = await passwordForm.validateFields()
      await changePassword({ currentPassword: values.currentPassword, newPassword: values.newPassword })
      passwordForm.resetFields()
      message.success(t('passwordChanged'))
    } catch (error) {
      if (error instanceof Error) message.error(errorMessage(error))
    } finally {
      setPasswordSaving(false)
    }
  }
  return <><a className="skip-link" href="#main-content">{t('skipToContent')}</a><Layout className="app-layout">
    <Sider width={244} collapsedWidth={72} collapsed={collapsed} className="app-sider" theme="light">
      <div className="sidebar-header">
        <button className="sidebar-brand" aria-label={t('dashboard')} onClick={() => navigate('/')}><BrandLogo small />{!collapsed && <span>DB Mock</span>}</button>
        <Button className="sidebar-collapse" type="text" aria-label={collapsed ? t('expandMenu') : t('collapse')} title={collapsed ? t('expandMenu') : t('collapse')} icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(!collapsed)} />
      </div>
      <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={({ key }) => navigate(key)} />
    </Sider>
    <Layout>
      <Header className="app-header">
        <Typography.Text type="secondary">{routeItems.find((item) => item.key === selected)?.label}</Typography.Text>
        <Space size={16}>
          <Button type="text" icon={<GlobalOutlined />} loading={languageSaving} aria-label={t(targetLocale === 'en-US' ? 'switchToEnglish' : 'switchToChinese')} onClick={() => void switchLanguage()}>{targetLocale === 'en-US' ? t('languageEnglish') : t('languageChinese')}</Button>
          <Badge count={activeAlerts} size="small" overflowCount={99}><Button type="text" aria-label={t('alerts')} title={t('alerts')} icon={<BellOutlined />} onClick={() => navigate('/alerts')} /></Badge>
          <Dropdown menu={{ items: [{ key: 'account', icon: <UserOutlined />, label: t('accountSettings'), onClick: openAccount }, { type: 'divider' }, { key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void logout() }] }}>
            <Button type="text" className="user-menu" aria-label={t('accountMenu')}><Avatar size={30}>{user?.displayName?.slice(0, 1).toUpperCase()}</Avatar><span className="desktop-only">{user?.displayName}</span><Tag className="desktop-only" bordered={false}>{t(`role_${user?.role}`)}</Tag><DownOutlined className="user-menu-caret" /></Button>
          </Dropdown>
        </Space>
      </Header>
      <Content id="main-content" tabIndex={-1} className="app-content">{!permissions.canOperate && <Alert className="read-only-banner" type="info" showIcon message={t('readOnlyMode')} description={t('readOnlyModeHint')} />}<Outlet /></Content>
    </Layout>
  </Layout>
    <Modal title={t('accountSettings')} open={accountOpen} onCancel={closeAccount} footer={<Button disabled={profileSaving || passwordSaving} onClick={closeAccount}>{t('close')}</Button>} forceRender destroyOnHidden maskClosable={!profileSaving && !passwordSaving} closable={!profileSaving && !passwordSaving}>
      <Typography.Paragraph type="secondary">{t('accountSettingsHint')}</Typography.Paragraph>
      <section className="account-settings-section" aria-labelledby="account-profile-heading">
        <Typography.Title id="account-profile-heading" level={5}><UserOutlined /> {t('profile')}</Typography.Title>
        <Form name="account-profile" form={profileForm} layout="vertical" requiredMark={false}>
          <Form.Item name="displayName" label={t('displayName')} rules={[{ required: true, whitespace: true, message: t('displayNameRequired') }, { max: 100, message: t('displayNameLength') }]}><Input autoComplete="name" /></Form.Item>
          <Form.Item name="locale" label={t('language')} rules={[{ required: true }]}><Select options={[{ value: 'zh-CN', label: t('languageChinese') }, { value: 'en-US', label: t('languageEnglish') }]} /></Form.Item>
          <Button type="primary" loading={profileSaving} disabled={passwordSaving} onClick={() => void saveProfile()}>{t('saveProfile')}</Button>
        </Form>
      </section>
      <Divider />
      <section className="account-settings-section" aria-labelledby="account-password-heading">
        <Typography.Title id="account-password-heading" level={5}><LockOutlined /> {t('changePassword')}</Typography.Title>
        <Alert className="account-password-hint" type="info" showIcon message={t('passwordChangeHint')} />
        <Form name="account-password" form={passwordForm} layout="vertical" requiredMark={false} autoComplete="off">
          <Form.Item name="currentPassword" label={t('currentPassword')} rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item>
          <Form.Item name="newPassword" label={t('newPassword')} rules={[{ required: true }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Form.Item name="confirmPassword" label={t('confirmNewPassword')} dependencies={['newPassword']} rules={[{ required: true }, { validator: (_, value) => value === passwordForm.getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error(t('passwordMismatch'))) }]}><Input.Password autoComplete="new-password" /></Form.Item>
          <Button type="primary" loading={passwordSaving} disabled={profileSaving} onClick={() => void savePassword()}>{t('changePassword')}</Button>
        </Form>
      </section>
    </Modal>
  </>
}
