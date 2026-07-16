import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Wiz — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Wiz authenticates with an OAuth2 service account (Client ID + Client Secret);
 * the connection endpoint is the tenant's regional Wiz API host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Wiz"
      appId="wiz"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="the Wiz service account Client ID"
      endpointPlaceholder="e.g. api.us17.app.wiz.io"
      endpointHelper="Your regional Wiz API host (find it in Wiz under Settings > Tenant)."
    />
  )
}
