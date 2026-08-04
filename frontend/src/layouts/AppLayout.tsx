import {
  AuditOutlined, CloudServerOutlined, DatabaseOutlined, DownOutlined, GlobalOutlined,
  HomeOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, UserOutlined,
} from '@ant-design/icons'
import { Alert, App, Avatar, Button, Dropdown, Form, Input, Layout, Menu, Modal, Select, Space, Tabs, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { BrandLogo } from '../components/BrandLogo'
import { PageHeaderTargetProvider } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { errorMessage } from '../lib/api'
import { oppositeLocale } from '../lib/locale'
import { permissionsFor } from '../lib/permissions'
import { displayNameReady, passwordReady } from '../lib/user-form'

const { Header, Sider, Content } = Layout
const compactNavigationQuery = '(max-width: 900px)'

interface AccountProfileForm { displayName: string; locale: 'zh-CN' | 'en-US' }
interface AccountPasswordForm { currentPassword: string; newPassword: string; confirmPassword: string }

export function AppLayout() {
  const [compactNavigation, setCompactNavigation] = useState(() => window.matchMedia(compactNavigationQuery).matches)
  const [collapsed, setCollapsed] = useState(() => window.matchMedia(compactNavigationQuery).matches)
  const { t, i18n } = useTranslation()
  const { message, modal } = App.useApp()
  const { user, logout, updateLocale, updateProfile, changePassword } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [pageHeaderTarget, setPageHeaderTarget] = useState<HTMLDivElement | null>(null)
  const [languageSaving, setLanguageSaving] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  const [accountTab, setAccountTab] = useState<'profile' | 'password'>('profile')
  const [profileSaving, setProfileSaving] = useState(false)
  const [passwordSaving, setPasswordSaving] = useState(false)
  const [profileDirty, setProfileDirty] = useState(false)
  const [passwordDirty, setPasswordDirty] = useState(false)
  const [profileForm] = Form.useForm<AccountProfileForm>()
  const [passwordForm] = Form.useForm<AccountPasswordForm>()
  const profileDisplayName = Form.useWatch('displayName', profileForm)
  const currentPassword = Form.useWatch('currentPassword', passwordForm)
  const newPassword = Form.useWatch('newPassword', passwordForm)
  const confirmPassword = Form.useWatch('confirmPassword', passwordForm)
  const profileSaveReady = profileDirty && displayNameReady(profileDisplayName)
  const passwordSaveReady = passwordDirty && !!currentPassword && passwordReady(newPassword) && confirmPassword === newPassword
  const profileBaseline = useRef<AccountProfileForm>({ displayName: '', locale: 'zh-CN' })
  const permissions = permissionsFor(user!)
  useEffect(() => {
    const media = window.matchMedia(compactNavigationQuery)
    const sync = () => {
      setCompactNavigation(media.matches)
      if (media.matches) setCollapsed(true)
    }
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])
  const dashboardItem = { key: '/dashboard', icon: <HomeOutlined />, label: t('workbench') }
  const hostsItem = { key: '/hosts', icon: <CloudServerOutlined />, label: t('hosts') }
  const instancesItem = { key: '/instances', icon: <DatabaseOutlined />, label: t('databases') }
  const tasksItem = { key: '/tasks', icon: <AuditOutlined />, label: t('tasks') }
  const routeItems = [dashboardItem, hostsItem, instancesItem, tasksItem]
  const items: MenuProps['items'] = routeItems
  const selectedItem = routeItems.find((item) => location.pathname.startsWith(item.key)) ?? dashboardItem
  const selected = selectedItem.key
  useEffect(() => {
    document.title = `${String(selectedItem.label)} · DB Mock`
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    const frame = window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.app-page-header-slot h2')?.focus({ preventScroll: true }))
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname, selectedItem.label])
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
    const profile = { displayName: user?.displayName || '', locale: user?.locale === 'en-US' ? 'en-US' as const : 'zh-CN' as const }
    profileBaseline.current = profile
    profileForm.setFieldsValue(profile)
    passwordForm.resetFields()
    setProfileDirty(false)
    setPasswordDirty(false)
    setAccountTab('profile')
    setAccountOpen(true)
  }
  const discardAccountChanges = () => {
    setAccountOpen(false)
    setProfileDirty(false)
    setPasswordDirty(false)
    profileForm.resetFields()
    passwordForm.resetFields()
  }
  const closeAccount = () => {
    if (profileSaving || passwordSaving) return
    if (!profileDirty && !passwordDirty) { discardAccountChanges(); return }
    modal.confirm({
      title: t('discardAccountChangesTitle'),
      content: t('discardAccountChangesHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: discardAccountChanges,
    })
  }
  const saveProfile = async () => {
    try {
      setProfileSaving(true)
      const values = await profileForm.validateFields()
      const normalizedValues = { ...values, displayName: values.displayName.trim() }
      await updateProfile(normalizedValues)
      profileBaseline.current = normalizedValues
      setProfileDirty(false)
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
      setPasswordDirty(false)
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
        <button
          className={`sidebar-brand${collapsed ? ' sidebar-brand-collapsed' : ''}`}
          aria-label={collapsed ? t('expandMenu') : t('workbench')}
          title={collapsed ? t('expandMenu') : undefined}
          onClick={() => collapsed ? setCollapsed(false) : navigate('/dashboard')}
        >
          <span className="sidebar-brand-mark"><BrandLogo small />{collapsed && <MenuUnfoldOutlined className="sidebar-expand-icon" />}</span>
          {!collapsed && <span>DB Mock</span>}
        </button>
        {!collapsed && <Button className="sidebar-collapse" type="text" aria-label={t('collapse')} title={t('collapse')} icon={<MenuFoldOutlined />} onClick={() => setCollapsed(true)} />}
      </div>
      <Menu mode="inline" selectedKeys={[selected]} items={items} onClick={({ key }) => { navigate(key); if (compactNavigation) setCollapsed(true) }} />
    </Sider>
    <Layout>
      <Header className="app-header">
        <div className="app-page-header">
          <div className="app-page-header-slot" ref={setPageHeaderTarget} />
          <Typography.Text className="app-header-fallback" type="secondary">{routeItems.find((item) => item.key === selected)?.label}</Typography.Text>
        </div>
        <Space className="app-header-tools" size={12}>
          <Button type="text" icon={<GlobalOutlined />} loading={languageSaving} aria-label={t(targetLocale === 'en-US' ? 'switchToEnglish' : 'switchToChinese')} onClick={() => void switchLanguage()}><span className="header-language-label">{targetLocale === 'en-US' ? t('languageEnglish') : t('languageChinese')}</span></Button>
          <Dropdown trigger={['click']} menu={{ items: [{ key: 'account', icon: <UserOutlined />, label: t('accountSettings'), onClick: openAccount }, { type: 'divider' }, { key: 'logout', icon: <LogoutOutlined />, label: t('logout'), onClick: () => void logout() }] }}>
            <Button type="text" className="user-menu" aria-label={t('accountMenu')}><Avatar size={30}>{user?.displayName?.slice(0, 1).toUpperCase()}</Avatar><span className="desktop-only">{user?.displayName}</span><DownOutlined className="user-menu-caret" /></Button>
          </Dropdown>
        </Space>
      </Header>
      <Content id="main-content" tabIndex={-1} className="app-content"><PageHeaderTargetProvider target={pageHeaderTarget}>{!permissions.canOperate && <Alert className="read-only-banner" type="info" showIcon message={t('readOnlyMode')} description={t('readOnlyModeHint')} />}<Outlet /></PageHeaderTargetProvider></Content>
    </Layout>
  </Layout>
    <Modal title={t('accountSettings')} open={accountOpen} onCancel={closeAccount} footer={<Button disabled={profileSaving || passwordSaving} onClick={closeAccount}>{t('close')}</Button>} forceRender destroyOnHidden maskClosable={!profileSaving && !passwordSaving} closable={!profileSaving && !passwordSaving} style={{ top: 24 }} styles={{ body: { maxHeight: 'calc(100vh - 190px)', overflowY: 'auto', paddingRight: 4 } }}>
      <Typography.Paragraph type="secondary">{t('accountSettingsHint')}</Typography.Paragraph>
      <Tabs
        className="account-settings-tabs"
        activeKey={accountTab}
        onChange={(key) => setAccountTab(key as 'profile' | 'password')}
        items={[
          {
            key: 'profile',
            label: <span><UserOutlined /> {t('profile')}</span>,
            children: <section className="account-settings-section" aria-label={t('profile')}>
              <Form name="account-profile" form={profileForm} layout="vertical" requiredMark={false} onValuesChange={(_, values) => setProfileDirty(values.displayName?.trim() !== profileBaseline.current.displayName || values.locale !== profileBaseline.current.locale)}>
                <Form.Item name="displayName" label={t('displayName')} rules={[{ required: true, whitespace: true, message: t('displayNameRequired') }, { max: 100, message: t('displayNameLength') }]}><Input autoComplete="name" /></Form.Item>
                <Form.Item name="locale" label={t('language')} rules={[{ required: true }]}><Select options={[{ value: 'zh-CN', label: t('languageChinese') }, { value: 'en-US', label: t('languageEnglish') }]} /></Form.Item>
                <Button type="primary" loading={profileSaving} disabled={passwordSaving || !profileSaveReady} onClick={() => void saveProfile()}>{t('saveProfile')}</Button>
              </Form>
            </section>,
          },
          {
            key: 'password',
            label: <span><LockOutlined /> {t('changePassword')}</span>,
            children: <section className="account-settings-section" aria-label={t('changePassword')}>
              <Alert className="account-password-hint" type="info" showIcon message={t('passwordChangeHint')} />
              <Form name="account-password" form={passwordForm} layout="vertical" requiredMark={false} autoComplete="off" onValuesChange={(_, values) => setPasswordDirty(Object.values(values).some(Boolean))}>
                <Form.Item name="currentPassword" label={t('currentPassword')} rules={[{ required: true, message: t('passwordRequired') }]}><Input.Password autoComplete="current-password" /></Form.Item>
                <Form.Item name="newPassword" label={t('newPassword')} extra={t('accountPasswordRulesHint')} rules={[{ required: true, message: t('passwordRequired') }, { validator: (_, value) => !value || passwordReady(value) ? Promise.resolve() : Promise.reject(new Error(t('passwordLength'))) }]}><Input.Password maxLength={128} autoComplete="new-password" /></Form.Item>
                <Form.Item name="confirmPassword" label={t('confirmNewPassword')} dependencies={['newPassword']} rules={[{ required: true }, { validator: (_, value) => value === passwordForm.getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error(t('passwordMismatch'))) }]}><Input.Password autoComplete="new-password" /></Form.Item>
                <Button type="primary" loading={passwordSaving} disabled={profileSaving || !passwordSaveReady} onClick={() => void savePassword()}>{t('changePassword')}</Button>
              </Form>
            </section>,
          },
        ]}
      />
    </Modal>
  </>
}
