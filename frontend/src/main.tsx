import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import { I18nextProvider, useTranslation } from 'react-i18next'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { SystemSettingsProvider } from './contexts/SystemSettingsContext'
import i18n from './i18n'
import './styles/global.css'

function ProductApp() {
  return <AuthProvider><SystemSettingsProvider><App /></SystemSettingsProvider></AuthProvider>
}

const router = createBrowserRouter([{ path: '*', element: <ProductApp /> }])

function Root() {
  const { i18n: active, t } = useTranslation()
  useEffect(() => { document.documentElement.lang = active.language }, [active.language])
  return (
    <ConfigProvider
      locale={active.language === 'en-US' ? enUS : zhCN}
      modal={{ closable: { 'aria-label': t('close') } }}
      theme={{
        token: {
          colorPrimary: '#2563eb',
          borderRadius: 10,
          fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        },
        components: { Layout: { headerBg: '#fff', siderBg: '#fff' }, Menu: { itemBorderRadius: 8 } },
      }}
    >
      <AntApp><RouterProvider router={router} /></AntApp>
    </ConfigProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><I18nextProvider i18n={i18n}><Root /></I18nextProvider></React.StrictMode>)
