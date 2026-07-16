import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Microsoft Sentinel — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Sentinel (via Azure Resource Manager) authenticates
 * with an Azure Entra app registration (OAuth2 client credentials): the Client
 * ID is the connection's username, the Client Secret its token.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Microsoft Sentinel"
      appId="microsoft-sentinel"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Entra app registration client ID"
      endpointPlaceholder="e.g. management.azure.com"
      endpointHelper="Azure Resource Manager host (set the Tenant ID, Subscription ID, Resource Group, Workspace Name and Azure Cloud in app settings)."
    />
  )
}
