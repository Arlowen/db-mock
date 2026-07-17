import { DatabaseOutlined, GlobalOutlined } from '@ant-design/icons'
import { App, Button, Card, Form, Input, Select, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { errorMessage } from '../lib/api'

export function AuthPage({ setup }: { setup: boolean }) {
  const { t, i18n } = useTranslation()
  const { login, setup: initialize } = useAuth()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const submit = async (values: { username: string; password: string; displayName?: string; locale?: string }) => {
    try {
      if (setup) await initialize({ username: values.username, password: values.password, displayName: values.displayName || values.username, locale: values.locale || i18n.language })
      else await login(values.username, values.password)
    } catch (error) { message.error(errorMessage(error)) }
  }
  return <div className="auth-shell">
    <Card className="auth-card" bordered={false}>
      <Space direction="vertical" size={24} style={{ width: '100%' }}>
        <div className="brand-lockup"><span className="brand-mark"><DatabaseOutlined /></span><div><Typography.Title level={2}>{t('app')}</Typography.Title><Typography.Text type="secondary">{t('appTagline')}</Typography.Text></div></div>
        <div><Typography.Title level={3}>{setup ? t('initialize') : t('login')}</Typography.Title>{setup && <Typography.Paragraph type="secondary">{t('initializeHint')}</Typography.Paragraph>}</div>
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ locale: i18n.language }} requiredMark={false}>
          <Form.Item label={t('username')} name="username" rules={[{ required: true }]}><Input size="large" autoFocus /></Form.Item>
          {setup && <Form.Item label={t('displayName')} name="displayName"><Input size="large" /></Form.Item>}
          <Form.Item label={t('password')} name="password" rules={[{ required: true }]}><Input.Password size="large" /></Form.Item>
          {setup && <Form.Item label={t('language')} name="locale"><Select size="large" options={[{ value: 'zh-CN', label: t('languageChinese') }, { value: 'en-US', label: t('languageEnglish') }]} /></Form.Item>}
          <Button htmlType="submit" type="primary" size="large" block>{setup ? t('initialize') : t('login')}</Button>
        </Form>
        <Button type="text" icon={<GlobalOutlined />} onClick={() => { const locale = i18n.language === 'zh-CN' ? 'en-US' : 'zh-CN'; void i18n.changeLanguage(locale); localStorage.setItem('dbmock-locale', locale) }}>{i18n.language === 'zh-CN' ? t('languageEnglish') : t('languageChinese')}</Button>
      </Space>
    </Card>
  </div>
}
