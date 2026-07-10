// ========================================================================
// Platform types available to app developers
// These represent the data apps receive from the platform
// ========================================================================

export interface Component {
  id: string
  hostname: string
  port: string
  type: string[]
  toolId: string
  customerId: string
}

export interface Credential {
  id: string
  name: string
  username: string
  password: string
  apiToken: string | null
  certificate: string | null
  toolId: string
  customerId: string
}

export interface Connectivity {
  id: string
  componentId: string
  status: string
  sshCommand: string | null
  httpsUrl: string | null
  tailscaleDeviceIP: string | null
}

export interface Tag {
  id: string
  name: string
  customerId: string
}

export interface User {
  id: string
  email: string
  name: string | null
  customerId: string
  roleId: string
}

export interface Customer {
  id: string
  name: string
  domain: string | null
  isActive: boolean
}
