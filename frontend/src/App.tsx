import { Spin } from 'antd'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './contexts/AuthContext'
import { useSystemSettings } from './contexts/SystemSettingsContext'
import { AppLayout } from './layouts/AppLayout'
import { AuthPage } from './pages/AuthPages'
import { DashboardPage } from './pages/DashboardPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { HostsPage } from './pages/HostsPage'
import { CatalogPage } from './pages/CatalogPage'
import { InstancesPage, InstanceDetailPage } from './pages/InstancesPage'
import { ImagesPage } from './pages/ImagesPage'
import { TasksPage } from './pages/TasksPage'
import { AlertsPage } from './pages/AlertsPage'
import { UsersPage } from './pages/UsersPage'
import { AuditPage } from './pages/AuditPage'
import { SettingsPage } from './pages/SettingsPage'

export default function App() {
  const { loading, initialized, user } = useAuth()
  const { loading: settingsLoading } = useSystemSettings()
  if (loading || settingsLoading) return <div className="full-spin"><Spin size="large" /></div>
  if (!initialized) return <AuthPage setup />
  if (!user) return <AuthPage setup={false} />
  return <Routes><Route element={<AppLayout />}><Route index element={<DashboardPage />} /><Route path="projects" element={<ProjectsPage />} /><Route path="hosts" element={<HostsPage />} /><Route path="catalog" element={<CatalogPage />} /><Route path="instances" element={<InstancesPage />} /><Route path="instances/:id" element={<InstanceDetailPage />} /><Route path="images" element={<ImagesPage />} /><Route path="tasks" element={<TasksPage />} /><Route path="alerts" element={<AlertsPage />} /><Route path="users" element={<UsersPage />} /><Route path="audit" element={<AuditPage />} /><Route path="settings" element={<SettingsPage />} /><Route path="*" element={<Navigate to="/" replace />} /></Route></Routes>
}
