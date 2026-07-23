export interface HostConnectionValues {
  sshAddress?: string
  sshPort?: number
  sshUser?: string
  authType?: string
  credential?: string
  dataRoot?: string
  portStart?: number
  portEnd?: number
}

function validPort(value?: number): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65535
}

export function hostPortPoolInvalid(values: HostConnectionValues | undefined): boolean {
  return Boolean(values && validPort(values.portStart) && validPort(values.portEnd) && values.portStart > values.portEnd)
}

export function hostConnectionReady(
  values: HostConnectionValues | undefined,
  credentialRequired: boolean,
): boolean {
  if (!values) return false
  if (!values.sshAddress?.trim() || !values.sshUser?.trim() || !values.dataRoot?.trim()) return false
  if (!['password', 'private_key'].includes(values.authType || '')) return false
  if (credentialRequired && !values.credential?.trim()) return false
  if (!validPort(values.sshPort) || !validPort(values.portStart) || !validPort(values.portEnd)) return false
  return !hostPortPoolInvalid(values)
}

export function dockerManagementReady(
  manageDocker: boolean | undefined,
  passwordlessSudo: boolean | undefined,
  editingManageDocker: boolean | undefined,
  verificationDirty: boolean,
): boolean {
  if (!manageDocker) return true
  if (passwordlessSudo !== undefined) return passwordlessSudo
  return Boolean(editingManageDocker && !verificationDirty)
}
