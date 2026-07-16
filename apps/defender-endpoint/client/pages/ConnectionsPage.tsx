import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Microsoft Defender for Endpoint — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Defender authenticates via an Azure AD app registration
 * (OAuth2 client credentials): the Client ID is the connection's username, the
 * Client Secret its token. The connection endpoint is the Defender API host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Microsoft Defender for Endpoint"
      appId="defender-endpoint"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Entra app registration client ID"
      endpointPlaceholder="e.g. api.security.microsoft.com"
      endpointHelper="Defender API host for your Azure cloud. Set the Tenant ID and Azure Cloud in app settings."
    />
  )
}
