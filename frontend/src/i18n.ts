import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

const zh: Record<string, string> = {
  app: 'DB Mock',
  dashboard: '总览', projects: '项目', hosts: '主机', catalog: '数据库目录', instances: '数据库实例',
  images: '镜像与仓库', tasks: '任务中心', alerts: '告警与 Webhook', users: '用户', audit: '审计日志', settings: '系统设置',
  navResources: '资源管理', navDatabases: '数据库管理', navOperations: '运维中心', navSystem: '系统管理',
  login: '登录', logout: '退出登录', username: '用户名', password: '密码', displayName: '显示名称', language: '语言',
  initialize: '初始化 DB Mock', initializeHint: '创建第一个账号以开始使用。所有账号拥有相同权限。',
  create: '创建', edit: '编辑', delete: '删除', save: '保存', cancel: '取消', confirm: '确认', refresh: '刷新', actions: '操作', status: '状态', name: '名称', description: '描述', createdAt: '创建时间',
  online: '在线', offline: '离线', pending: '等待中', running: '运行中', stopped: '已停止', failed: '失败', provisioning: '创建中', degraded: '异常', needs_docker: '需要 Docker', experimental: '实验性', standard: '标准', custom: '自定义',
  addHost: '接入主机', testConnection: '测试连接', confirmFingerprint: '确认 SSH 指纹', installDocker: '安装 Docker', upgradeDocker: '升级 Docker', maintenance: '维护模式',
  createInstance: '创建数据库', connection: '连接信息', logs: '日志', metrics: '监控', start: '启动', stop: '停止', restart: '重启', upgrade: '升级',
  uploadImage: '上传离线镜像', uploadTemplate: '上传 Compose 模板', registry: '镜像仓库', project: '项目', environment: '环境', host: '主机', template: '模板', version: '版本', resources: '资源',
  cpu: 'CPU', memory: '内存', disk: '磁盘', port: '端口', autoSelect: '自动推荐', autoRestart: '异常自动重启', noData: '暂无数据', details: '详情', taskLogs: '任务日志', retry: '重试', acknowledge: '确认', resolve: '解决',
  webhook: 'Webhook', search: '搜索', export: '导出 CSV', clear: '清理', dangerConfirm: '此操作不可撤销，请输入名称确认',
}

const en: Record<string, string> = {
  app: 'DB Mock', dashboard: 'Dashboard', projects: 'Projects', hosts: 'Hosts', catalog: 'Database catalog', instances: 'Instances', images: 'Images & registries', tasks: 'Tasks', alerts: 'Alerts & webhooks', users: 'Users', audit: 'Audit log', settings: 'Settings',
  navResources: 'RESOURCES', navDatabases: 'DATABASES', navOperations: 'OPERATIONS', navSystem: 'SYSTEM',
  login: 'Sign in', logout: 'Sign out', username: 'Username', password: 'Password', displayName: 'Display name', language: 'Language', initialize: 'Initialize DB Mock', initializeHint: 'Create the first account. Every account has the same permissions.',
  create: 'Create', edit: 'Edit', delete: 'Delete', save: 'Save', cancel: 'Cancel', confirm: 'Confirm', refresh: 'Refresh', actions: 'Actions', status: 'Status', name: 'Name', description: 'Description', createdAt: 'Created',
  online: 'Online', offline: 'Offline', pending: 'Pending', running: 'Running', stopped: 'Stopped', failed: 'Failed', provisioning: 'Provisioning', degraded: 'Degraded', needs_docker: 'Docker required', experimental: 'Experimental', standard: 'Standard', custom: 'Custom',
  addHost: 'Add host', testConnection: 'Test connection', confirmFingerprint: 'Confirm SSH fingerprint', installDocker: 'Install Docker', upgradeDocker: 'Upgrade Docker', maintenance: 'Maintenance',
  createInstance: 'Create database', connection: 'Connection', logs: 'Logs', metrics: 'Metrics', start: 'Start', stop: 'Stop', restart: 'Restart', upgrade: 'Upgrade',
  uploadImage: 'Upload offline image', uploadTemplate: 'Upload Compose template', registry: 'Registry', project: 'Project', environment: 'Environment', host: 'Host', template: 'Template', version: 'Version', resources: 'Resources',
  cpu: 'CPU', memory: 'Memory', disk: 'Disk', port: 'Port', autoSelect: 'Auto select', autoRestart: 'Auto restart', noData: 'No data', details: 'Details', taskLogs: 'Task logs', retry: 'Retry', acknowledge: 'Acknowledge', resolve: 'Resolve',
  webhook: 'Webhook', search: 'Search', export: 'Export CSV', clear: 'Clear', dangerConfirm: 'This cannot be undone. Type the name to confirm.',
}

i18n.use(initReactI18next).init({
  resources: { 'zh-CN': { translation: zh }, 'en-US': { translation: en } },
  lng: localStorage.getItem('dbmock-locale') || 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: { escapeValue: false },
})

export default i18n
