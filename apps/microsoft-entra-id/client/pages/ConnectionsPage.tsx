import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Microsoft Entra ID — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Entra authenticates as an app registration via OAuth2
 * client credentials: the Application (client) ID goes in the username field and
 * the client secret in the secret field. Saving a connection also registers the
 * entra-tenant deploy target, so Deploy is enabled. The directory (tenant) ID is
 * set separately in the app's Tenant ID setting.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Microsoft Entra ID"
      appId="microsoft-entra-id"
      usernameLabel="Application (client) ID"
      usernameOptionalForToken={false}
      tokenLabel="Client secret"
      tokenUsernamePlaceholder="app registration Application (client) ID"
      endpointPlaceholder="https://graph.microsoft.com"
      endpointHelper="Informational only — Microsoft Graph is reached at graph.microsoft.com; the directory (tenant) ID is set in the app's Tenant ID setting."
      componentType="entra-tenant"
    />
  )
}
