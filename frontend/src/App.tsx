import { Spin } from 'antd'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { useSystemSettings } from './contexts/SystemSettingsContext'
import { AppLayout } from './layouts/AppLayout'
import { AuthPage } from './pages/AuthPages'
import { HostsPage } from './pages/HostsPage'
import { InstanceDetailPage } from './pages/InstanceDetailPage'
import { InstancesPage } from './pages/InstancesPage'
import { TasksPage } from './pages/TasksPage'
import { DashboardPage } from './pages/DashboardPage'

const databaseLegacyRoutes = ['projects', 'catalog', 'images']
const dashboardLegacyRoutes = ['alerts', 'users', 'audit', 'settings']

export default function App() {
  const { loading, initialized, user } = useAuth()
  const { loading: settingsLoading } = useSystemSettings()
  if (loading || settingsLoading) return <div className="full-spin"><Spin size="large" /></div>
  if (!initialized) return <AuthPage setup />
  if (!user) return <AuthPage setup={false} />
  return <Routes>
    <Route element={<AppLayout />}>
      <Route index element={<Navigate to="/dashboard" replace />} />
      <Route path="dashboard" element={<DashboardPage />} />
      <Route path="hosts" element={<HostsPage />} />
      <Route path="instances" element={<InstancesPage />} />
      <Route path="instances/:id" element={<InstanceDetailPage />} />
      <Route path="tasks" element={<TasksPage />} />
      {databaseLegacyRoutes.map((path) => <Route key={path} path={`${path}/*`} element={<Navigate to="/instances" replace />} />)}
      {dashboardLegacyRoutes.map((path) => <Route key={path} path={`${path}/*`} element={<Navigate to="/dashboard" replace />} />)}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Route>
  </Routes>
}
