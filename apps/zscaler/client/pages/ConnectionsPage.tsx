import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Zscaler — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Zscaler OneAPI (Zidentity) authenticates with an OAuth2 client-credentials
 * pair: the Client ID is the connection's username, the Client Secret its token.
 * The connection endpoint is the tenant vanity domain.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Zscaler"
      appId="zscaler"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Zidentity OAuth2 client ID"
      endpointPlaceholder="e.g. company.zslogin.net"
      endpointHelper="Your Zscaler tenant vanity domain (Zidentity). The cloud is selected in app settings."
    />
  )
}
