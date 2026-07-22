import { DatabaseOutlined, GlobalOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../contexts/AuthContext'
import { errorMessage } from '../lib/api'
import { applyLocale, oppositeLocale } from '../lib/locale'

export function AuthPage({ setup }: { setup: boolean }) {
  const { t, i18n } = useTranslation()
  const { login, setup: initialize, sessionExpired } = useAuth()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const targetLocale = oppositeLocale(i18n.language)
  const switchLanguage = async () => { await applyLocale(targetLocale) }
  const submit = async (values: { username: string; password: string }) => {
    try {
      if (setup) await initialize({ username: values.username, password: values.password, displayName: values.username, locale: i18n.language })
      else await login(values.username, values.password)
    } catch (error) { message.error(errorMessage(error)) }
  }
  return <div className="auth-shell">
    <Card className="auth-card" bordered={false}>
      <Space direction="vertical" size={24} style={{ width: '100%' }}>
        <div className="brand-lockup"><span className="brand-mark"><DatabaseOutlined /></span><div><Typography.Title level={2}>{t('app')}</Typography.Title><Typography.Text type="secondary">{t('appTagline')}</Typography.Text></div></div>
        <div><Typography.Title level={3}>{setup ? t('initialize') : t('login')}</Typography.Title>{setup && <Typography.Paragraph type="secondary">{t('initializeHint')}</Typography.Paragraph>}</div>
        {!setup && sessionExpired && <Alert type="warning" showIcon message={t('sessionExpiredTitle')} description={t('sessionExpiredHint')} />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item label={t('username')} name="username" rules={[{ required: true }]}><Input size="large" autoFocus /></Form.Item>
          <Form.Item label={t('password')} name="password" rules={[{ required: true }]}><Input.Password size="large" /></Form.Item>
          <Button htmlType="submit" type="primary" size="large" block>{setup ? t('initialize') : t('login')}</Button>
        </Form>
        <Button type="text" icon={<GlobalOutlined />} aria-label={t(targetLocale === 'en-US' ? 'switchToEnglish' : 'switchToChinese')} onClick={() => void switchLanguage()}>{targetLocale === 'en-US' ? t('languageEnglish') : t('languageChinese')}</Button>
      </Space>
    </Card>
  </div>
}
