import type { Host } from './types'

export interface MVPHostValues {
  name: string
  sshAddress: string
  sshPort: number
  sshUser: string
  authType: string
  credential?: string
  passphrase?: string
  connectionAddress?: string
  dataRoot: string
  portStart: number
  portEnd: number
}

/**
 * Builds the MVP host request while preserving fields owned by the former
 * project, Docker-management, proxy, and policy UIs on existing hosts.
 */
export function mvpHostPayload(values: MVPHostValues, existing?: Host) {
  return {
    ...values,
    projectId: existing?.projectId,
    manageDocker: existing?.manageDocker ?? false,
    proxyHttp: existing?.proxyHttp ?? '',
    proxyHttps: existing?.proxyHttps ?? '',
    proxyNoProxy: existing?.proxyNoProxy ?? '',
    maintenance: existing?.maintenance ?? false,
    autoRestartDefault: existing?.autoRestartDefault ?? true,
    labels: existing?.labels ?? {},
  }
}
