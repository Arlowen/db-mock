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

export function mvpHostPayload(values: MVPHostValues) { return { ...values } }
