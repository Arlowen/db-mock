export interface User { id: string; username: string; displayName: string; locale: string; disabledAt?: string; lastLoginAt?: string; createdAt: string }
export interface Project { id: string; name: string; description: string; color: string; createdAt: string }
export interface Host { id: string; projectId?: string; name: string; sshAddress: string; sshPort: number; sshUser: string; authType: string; hostKey?: string; connectionAddress: string; dataRoot: string; portStart: number; portEnd: number; manageDocker: boolean; os?: string; distro?: string; architecture?: string; dockerVersion?: string; composeVersion?: string; cpuCount: number; memoryBytes: number; diskTotalBytes: number; diskFreeBytes: number; status: string; statusMessage?: string; maintenance: boolean; autoRestartDefault: boolean; lastSeenAt?: string }
export interface Registry { id: string; name: string; url: string; username?: string; hasPassword: boolean; hasCaCertificate: boolean; status: string }
export interface TemplateVersion { id: string; templateId: string; version: string; imageReference: string; architectures: string[]; minCpu: number; minMemoryBytes: number; minDiskBytes: number; defaultPort: number; manifest: Record<string, unknown>; createdAt: string }
export interface DatabaseTemplate { id: string; slug: string; name: string; nameZh: string; description: string; category: string; tier: 'standard' | 'experimental' | 'custom'; builtin: boolean; icon: string; riskReport: Array<{ code: string; severity: string; message: string }>; versions: TemplateVersion[] }
export interface Instance { id: string; name: string; projectId?: string; hostId: string; templateVersionId: string; environment: string; labels: Record<string, string>; status: string; statusMessage?: string; desiredState: string; autoRestart: boolean; restartFailures: number; cpu: number; memoryBytes: number; reservedDiskBytes: number; hostPort: number; containerPort: number; bindAddress: string; databaseUsername: string; databaseName: string; templateSlug: string; templateName: string; templateVersion: string; hostName: string; connectionAddress: string; createdAt: string; updatedAt?: string; lastHealthyAt?: string }
export interface Task { id: string; kind: string; status: string; resourceType: string; resourceId?: string; progress: number; stage: string; message: string; errorCode?: string; errorMessage?: string; cancelable: boolean; cancelAsked: boolean; attempts: number; createdAt: string; startedAt?: string; finishedAt?: string; updatedAt?: string }
export interface Alert { id: string; severity: string; type: string; resourceType: string; resourceId: string; title: string; message: string; status: string; createdAt: string }
export interface Webhook { id: string; name: string; url: string; hasSecret: boolean; events: string[]; enabled: boolean }
export interface Audit { id: number; username: string; action: string; resourceType: string; resourceName: string; ip: string; result: string; message: string; createdAt: string }
export interface ImageArtifact { id: string; name: string; filename: string; sizeBytes: number; sha256: string; format: string; imageRefs: string[]; architectures: string[]; status: string; createdAt: string }

export const bytes = (value?: number): string => {
  if (!value) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`
}
