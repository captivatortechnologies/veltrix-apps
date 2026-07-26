import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Netskope — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * Netskope authenticates with a REST API v2 token (stored in the secret field).
 * Saving a connection also registers the netskope deploy target, so Deploy is
 * enabled. The tenant host is set in the app's Tenant setting.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Netskope"
      appId="netskope"
      usernameLabel="Username (not required)"
      usernameOptionalForToken={true}
      tokenLabel="REST API v2 token"
      tokenUsernamePlaceholder="not required for a token"
      endpointPlaceholder="acme.goskope.com"
      endpointHelper="Informational only — set the tenant host in the app's Tenant setting."
      componentType="netskope"
    />
  )
}
