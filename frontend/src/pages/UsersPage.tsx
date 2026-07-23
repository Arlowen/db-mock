import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Grid, Input, Modal, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState, PageHeader } from '../components/Common'
import { useAuth } from '../contexts/AuthContext'
import { useSystemSettings } from '../contexts/SystemSettingsContext'
import { api, errorMessage } from '../lib/api'
import { formatDateTime } from '../lib/localization'
import {
  passwordReady,
  userDraftChanged,
  userFormReady,
  usernamePattern,
  type UserFormValues,
} from '../lib/user-form'
import type { User, UserRole } from '../lib/types'

export function UsersPage() {
  const { t, i18n } = useTranslation()
  const { timezone } = useSystemSettings()
  const { message, modal } = App.useApp()
  const { user: currentUser, reload: reloadCurrentUser } = useAuth()
  const screens = Grid.useBreakpoint()
  const [items, setItems] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<User | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<UserRole | ''>('')
  const [statusFilter, setStatusFilter] = useState<'active' | 'disabled' | ''>('')
  const [page, setPage] = useState(1)
  const [form] = Form.useForm<UserFormValues>()
  const draftBaseline = useRef<UserFormValues | null>(null)

  const username = Form.useWatch('username', form)
  const displayName = Form.useWatch('displayName', form)
  const password = Form.useWatch('password', form)
  const selectedRole = Form.useWatch('role', form)
  const selectedLocale = Form.useWatch('locale', form)
  const selectedDisabled = Form.useWatch('disabled', form)
  const saveReady = userFormReady({
    username,
    displayName,
    password,
    role: selectedRole,
    locale: selectedLocale,
    disabled: selectedDisabled,
  }, !!editing, draftDirty)

  const load = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true)
    try {
      const response = await api<{ items: User[] }>('/users')
      setItems(response.items)
      setLoadError('')
    } catch (error) {
      setLoadError(errorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const filteredItems = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase()
    return items.filter((item) => {
      const matchesSearch = !needle || `${item.displayName} ${item.username}`.toLocaleLowerCase().includes(needle)
      const matchesRole = !roleFilter || item.role === roleFilter
      const matchesStatus = !statusFilter || (statusFilter === 'disabled' ? !!item.disabledAt : !item.disabledAt)
      return matchesSearch && matchesRole && matchesStatus
    })
  }, [items, roleFilter, search, statusFilter])

  const filtersActive = !!search.trim() || !!roleFilter || !!statusFilter
  const compactTable = screens.md === false
  const maxPage = Math.max(1, Math.ceil(filteredItems.length / 20))
  useEffect(() => { if (page > maxPage) setPage(maxPage) }, [maxPage, page])
  const clearFilters = () => {
    setSearch('')
    setRoleFilter('')
    setStatusFilter('')
    setPage(1)
  }

  const show = (item?: User) => {
    const values: UserFormValues = item
      ? { displayName: item.displayName, password: '', locale: item.locale, role: item.role, disabled: !!item.disabledAt }
      : { username: '', displayName: '', password: '', locale: i18n.language, role: 'viewer', disabled: false }
    setEditing(item || null)
    setSaveError('')
    setDraftDirty(false)
    draftBaseline.current = values
    form.resetFields()
    form.setFieldsValue(values)
    setOpen(true)
  }

  const finishCloseEditor = () => {
    setOpen(false)
    setEditing(null)
    setSaveError('')
    setDraftDirty(false)
    draftBaseline.current = null
    form.resetFields()
  }

  const closeEditor = () => {
    if (saving) return
    if (!draftDirty) {
      finishCloseEditor()
      return
    }
    modal.confirm({
      title: t('discardUserDraftTitle'),
      content: t('discardUserDraftHint'),
      okText: t('discardChanges'),
      cancelText: t('continueEditing'),
      okButtonProps: { danger: true },
      onOk: finishCloseEditor,
    })
  }

  const save = async () => {
    try {
      setSaveError('')
      setSaving(true)
      const values = await form.validateFields()
      const body = editing
        ? {
            displayName: values.displayName?.trim(),
            locale: values.locale,
            role: editing.id === currentUser?.id ? undefined : values.role,
            password: values.password || '',
            disabled: !!values.disabled,
          }
        : {
            username: values.username?.trim(),
            displayName: values.displayName?.trim(),
            locale: values.locale,
            role: values.role,
            password: values.password,
          }
      await api(editing ? `/users/${editing.id}` : '/users', { method: editing ? 'PATCH' : 'POST', body })
      if (editing?.id === currentUser?.id) await reloadCurrentUser()
      message.success(t('saved'))
      finishCloseEditor()
      await load()
    } catch (error) {
      if (error instanceof Error) setSaveError(errorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const roleTag = (role: UserRole) => <Tag color={role === 'admin' ? 'blue' : role === 'operator' ? 'cyan' : undefined}>{t(`role_${role}`)}</Tag>
  const localeTag = (locale: string) => <Tag>{locale === 'zh-CN' ? t('languageChinese') : t('languageEnglish')}</Tag>
  const statusTag = (item: User) => <Tag color={item.disabledAt ? 'default' : 'green'}>{item.disabledAt ? t('disabled') : t('active')}</Tag>
  const identity = (item: User) => {
    const avatar = item.displayName.trim().slice(0, 1) || item.username.slice(0, 1)
    return <Space align="start">
      <span className="user-avatar">{avatar.toUpperCase()}</span>
      <div className="user-name-cell">
        <Space size={6} wrap>
          <Button className="user-name-button" type="link" onClick={() => show(item)}>{item.displayName}</Button>
          {item.id === currentUser?.id && <Tag color="blue">{t('currentAccount')}</Tag>}
        </Space>
        <Typography.Text type="secondary">{item.username}</Typography.Text>
      </div>
    </Space>
  }

  const editButton = (item: User) => <Button type="text" aria-label={`${t('edit')} ${item.displayName}`} title={t('edit')} icon={<EditOutlined />} onClick={() => show(item)} />
  const compactColumns = [{
    title: t('user'),
    render: (_: unknown, item: User) => <div className="user-compact-record">
      <div className="user-compact-heading">
        {identity(item)}
        {editButton(item)}
      </div>
      <Space className="user-compact-tags" size={[4, 6]} wrap>
        {roleTag(item.role)}
        {statusTag(item)}
        {localeTag(item.locale)}
      </Space>
      <div className="user-compact-meta">
        <Typography.Text type="secondary">{t('lastLogin')}: {formatDateTime(item.lastLoginAt, i18n.language, timezone)}</Typography.Text>
        <Typography.Text type="secondary">{t('createdAt')}: {formatDateTime(item.createdAt, i18n.language, timezone)}</Typography.Text>
      </div>
    </div>,
  }]

  const columns = [
    {
      title: t('username'),
      dataIndex: 'username',
      width: 230,
      render: (_value: string, item: User) => identity(item),
    },
    { title: t('role'), dataIndex: 'role', width: 120, render: (value: UserRole) => roleTag(value) },
    { title: t('language'), dataIndex: 'locale', width: 120, render: (value: string) => localeTag(value) },
    { title: t('status'), width: 100, render: (_: unknown, item: User) => statusTag(item) },
    { title: t('lastLogin'), dataIndex: 'lastLoginAt', width: 180, render: (value?: string) => formatDateTime(value, i18n.language, timezone) },
    { title: t('createdAt'), dataIndex: 'createdAt', width: 180, render: (value: string) => formatDateTime(value, i18n.language, timezone) },
    { title: '', width: 56, fixed: 'right' as const, render: (_: unknown, item: User) => editButton(item) },
  ]

  const passwordExtra = <Space direction="vertical" size={0}>
    <span>{t('accountPasswordRulesHint')}</span>
    {editing && <span>{t(editing.id === currentUser?.id ? 'passwordResetSelfHint' : 'passwordResetOtherHint')}</span>}
  </Space>

  return <>
    <PageHeader title={t('users')} description={t('usersDescription')} />
    {loadError && <Alert className="instance-page-alert" type={items.length ? 'warning' : 'error'} showIcon message={t('userListLoadFailed')} description={loadError} action={<Button size="small" loading={loading} onClick={() => void load(true)}>{t('retry')}</Button>} />}
    {(items.length > 0 || !loadError) && <Card className="user-table-card" title={t('users')} extra={<Button type="primary" icon={<PlusOutlined />} onClick={() => show()}>{t('createUser')}</Button>}>
      <div className="user-toolbar">
        <div className="user-filter-controls">
          <Input.Search className="user-search" allowClear aria-label={t('searchUsersLabel')} placeholder={t('searchUsersPlaceholder')} value={search} onChange={(event) => { setSearch(event.target.value); setPage(1) }} />
          <Select className="user-filter" aria-label={t('role')} value={roleFilter} onChange={(value) => { setRoleFilter(value); setPage(1) }} options={[
            { value: '', label: t('allRoles') },
            { value: 'admin', label: t('role_admin') },
            { value: 'operator', label: t('role_operator') },
            { value: 'viewer', label: t('role_viewer') },
          ]} />
          <Select className="user-filter" aria-label={t('status')} value={statusFilter} onChange={(value) => { setStatusFilter(value); setPage(1) }} options={[
            { value: '', label: t('allStatuses') },
            { value: 'active', label: t('active') },
            { value: 'disabled', label: t('disabled') },
          ]} />
        </div>
        <div className="user-toolbar-summary">
          <Typography.Text className="user-result-count" type="secondary">{t(filtersActive ? 'userFilteredResultCount' : 'userResultCount', { filtered: filteredItems.length, total: items.length, count: items.length })}</Typography.Text>
          <Button className="user-refresh-button" type="text" aria-label={t('refresh')} title={t('refresh')} icon={<ReloadOutlined />} loading={loading} onClick={() => void load(true)}>{compactTable ? null : t('refresh')}</Button>
        </div>
      </div>
      <Table
        rowKey="id"
        loading={loading}
        dataSource={filteredItems}
        pagination={{ current: page, pageSize: 20, hideOnSinglePage: true, showSizeChanger: false, onChange: setPage }}
        columns={compactTable ? compactColumns : columns}
        tableLayout={compactTable ? 'fixed' : undefined}
        scroll={compactTable ? undefined : { x: 986 }}
        locale={{ emptyText: <EmptyState compact action={filtersActive ? clearFilters : undefined} actionLabel={t('clearFilters')} description={t(filtersActive ? 'userFilteredEmptyDescription' : 'usersEmptyDescription')} /> }}
      />
    </Card>}

    <Modal
      title={editing ? `${t('edit')} · ${editing.displayName}` : t('createUser')}
      open={open}
      onCancel={closeEditor}
      onOk={() => void save()}
      confirmLoading={saving}
      closable={!saving}
      maskClosable={!saving}
      cancelButtonProps={{ disabled: saving }}
      okButtonProps={{ disabled: !saveReady }}
      okText={t('save')}
      width={620}
      style={{ top: compactTable ? 12 : 32 }}
      styles={{ body: { maxHeight: 'calc(100vh - 180px)', overflowY: 'auto', paddingRight: 4 } }}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        autoComplete="off"
        onValuesChange={(_, values) => {
          setSaveError('')
          setDraftDirty(userDraftChanged(values, draftBaseline.current))
        }}
      >
        {saveError && <Alert className="user-permission-note" type="error" showIcon message={t('userSaveFailed')} description={saveError} />}
        {!editing && <>
          <Alert className="user-permission-note" type="info" showIcon message={t('newUserPermissionsHint')} />
          <Form.Item name="username" label={t('username')} extra={t('usernameRulesHint')} rules={[
            { required: true, whitespace: true, message: t('usernameRequired') },
            { min: 3, max: 64, message: t('usernameLength') },
            { pattern: usernamePattern, message: t('usernameInvalid') },
          ]}><Input autoFocus maxLength={64} autoComplete="off" data-1p-ignore data-lpignore="true" /></Form.Item>
        </>}
        <Form.Item name="displayName" label={t('displayName')} rules={[
          { required: true, whitespace: true, message: t('displayNameRequired') },
          { max: 100, message: t('displayNameLength') },
        ]}><Input autoFocus={!!editing} maxLength={100} /></Form.Item>
        <Form.Item
          name="role"
          label={t('role')}
          extra={<Space direction="vertical" size={0}><span>{t(selectedRole === 'admin' ? 'roleAdminHint' : selectedRole === 'operator' ? 'roleOperatorHint' : 'roleViewerHint')}</span>{editing && <span>{t(editing.id === currentUser?.id ? 'cannotChangeCurrentRole' : 'roleChangeSessionHint')}</span>}</Space>}
          rules={[{ required: true }]}
        ><Select disabled={editing?.id === currentUser?.id} options={[
          { value: 'admin', label: t('role_admin') },
          { value: 'operator', label: t('role_operator') },
          { value: 'viewer', label: t('role_viewer') },
        ]} /></Form.Item>
        {editing && editing.id !== currentUser?.id && ((selectedRole && selectedRole !== editing.role) || (!!selectedDisabled !== !!editing.disabledAt)) && <Alert className="user-permission-note" type="warning" showIcon message={t('userAccessChangeWarning')} description={t('userAccessChangeWarningHint')} />}
        <Form.Item
          name="password"
          label={editing ? `${t('password')} (${t('leaveEmptyToKeep')})` : t('password')}
          extra={passwordExtra}
          rules={[
            ...(editing ? [] : [{ required: true, message: t('passwordRequired') }]),
            { validator: (_, value) => !value || passwordReady(value) ? Promise.resolve() : Promise.reject(new Error(t('passwordLength'))) },
          ]}
        ><Input.Password maxLength={128} autoComplete="new-password" data-1p-ignore data-lpignore="true" /></Form.Item>
        <Form.Item name="locale" label={t('language')} rules={[{ required: true }]}><Select options={[
          { value: 'zh-CN', label: t('languageChinese') },
          { value: 'en-US', label: t('languageEnglish') },
        ]} /></Form.Item>
        {editing && <Form.Item name="disabled" label={t('disableAccount')} valuePropName="checked" extra={t(editing.id === currentUser?.id ? 'cannotDisableCurrentUser' : 'disableUserHint')}><Switch aria-label={t('disableAccount')} disabled={editing.id === currentUser?.id} /></Form.Item>}
      </Form>
    </Modal>
  </>
}
