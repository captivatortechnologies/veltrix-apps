import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cisco Secure Firewall (FMC) - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. FMC authenticates with a plain username + password
 * (no API key/token concept for this app - see lib/fmc.ts), so this uses the
 * manager's standard username/password credential mode.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cisco Secure Firewall"
      appId="cisco-secure-firewall"
      componentType="fmc"
      usernameLabel="FMC Username"
      usernameOptionalForToken={false}
      tokenLabel="Password"
      tokenUsernamePlaceholder="e.g. veltrix-automation"
      endpointPlaceholder="e.g. fmc.example.com"
      endpointHelper="The FMC management address (host or host:port). Authentication is a local/RBAC FMC user's username and password."
    />
  )
}
