import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Microsoft Intune — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Intune (via Microsoft Graph) authenticates with an
 * Azure AD app registration (OAuth2 client credentials): the Client ID is the
 * connection's username, the Client Secret its token.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Microsoft Intune"
      appId="microsoft-intune"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Entra app registration client ID"
      endpointPlaceholder="e.g. graph.microsoft.com"
      endpointHelper="Microsoft Graph host (set the Tenant ID and Azure Cloud in app settings)."
    />
  )
}
