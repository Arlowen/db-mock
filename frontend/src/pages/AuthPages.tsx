import { GlobalOutlined } from '@ant-design/icons'
import { Alert, App, Button, Card, Form, Input, Space, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { BrandLogo } from '../components/BrandLogo'
import { useAuth } from '../contexts/AuthContext'
import { errorMessage } from '../lib/api'
import { applyLocale, oppositeLocale } from '../lib/locale'
import { passwordReady, usernamePattern, usernameReady } from '../lib/user-form'

interface CredentialForm {
  username: string
  password: string
}

export function AuthPage({ setup }: { setup: boolean }) {
  const { t, i18n } = useTranslation()
  const { login, setup: initialize, sessionExpired } = useAuth()
  const { message } = App.useApp()
  const [form] = Form.useForm<CredentialForm>()
  const username = Form.useWatch('username', form)
  const password = Form.useWatch('password', form)
  const submitReady = setup ? usernameReady(username) && passwordReady(password) : !!username?.trim() && !!password
  const targetLocale = oppositeLocale(i18n.language)
  const switchLanguage = async () => { await applyLocale(targetLocale) }
  const submit = async (values: CredentialForm) => {
    try {
      const normalizedUsername = values.username.trim()
      if (setup) await initialize({ username: normalizedUsername, password: values.password, displayName: normalizedUsername, locale: i18n.language })
      else await login(normalizedUsername, values.password)
    } catch (error) { message.error(errorMessage(error)) }
  }
  return <div className="auth-shell">
    <Card className="auth-card" bordered={false}>
      <Space direction="vertical" size={24} style={{ width: '100%' }}>
        <div className="brand-lockup"><BrandLogo /><div><Typography.Title level={2}>{t('app')}</Typography.Title><Typography.Text type="secondary">{t('appTagline')}</Typography.Text></div></div>
        <div><Typography.Title level={3}>{setup ? t('initialize') : t('login')}</Typography.Title>{setup && <Typography.Paragraph type="secondary">{t('initializeHint')}</Typography.Paragraph>}</div>
        {!setup && sessionExpired && <Alert type="warning" showIcon message={t('sessionExpiredTitle')} description={t('sessionExpiredHint')} />}
        <Form form={form} layout="vertical" onFinish={submit} requiredMark={false}>
          <Form.Item label={t('username')} name="username" extra={setup ? t('usernameRulesHint') : undefined} rules={[
            { required: true, whitespace: true, message: t('usernameRequired') },
            ...(setup ? [{ min: 3, max: 64, message: t('usernameLength') }, { pattern: usernamePattern, message: t('usernameInvalid') }] : []),
          ]}><Input size="large" autoFocus maxLength={setup ? 64 : undefined} /></Form.Item>
          <Form.Item label={t('password')} name="password" extra={setup ? t('accountPasswordRulesHint') : undefined} rules={[
            { required: true, message: t('passwordRequired') },
            ...(setup ? [{ validator: (_: unknown, value: string) => !value || passwordReady(value) ? Promise.resolve() : Promise.reject(new Error(t('passwordLength'))) }] : []),
          ]}><Input.Password size="large" maxLength={setup ? 128 : undefined} /></Form.Item>
          <Button htmlType="submit" type="primary" size="large" block disabled={!submitReady}>{setup ? t('initialize') : t('login')}</Button>
        </Form>
        <Button type="text" icon={<GlobalOutlined />} aria-label={t(targetLocale === 'en-US' ? 'switchToEnglish' : 'switchToChinese')} onClick={() => void switchLanguage()}>{targetLocale === 'en-US' ? t('languageEnglish') : t('languageChinese')}</Button>
      </Space>
    </Card>
  </div>
}
