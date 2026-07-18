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
