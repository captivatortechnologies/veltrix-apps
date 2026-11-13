import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/** Shared ConnectionsManager discovers the manifest's Microsoft OAuth onboarding flow.
 * Manual secrets/certificates remain available for existing registrations. */
export default function ConnectionsPage() {
  return (
    <>
    <p>Choose <strong>Integrate with Microsoft (OAuth)</strong> to sign in and approve the connector. Your directory is captured automatically. Use a manual connection for an existing app registration.</p>
    <ConnectionsManager
      appName="Microsoft Entra ID"
      appId="microsoft-entra-id"
      usernameLabel="Application (client) ID"
      usernameOptionalForToken={false}
      tokenLabel="Client secret"
      tokenUsernamePlaceholder="app registration Application (client) ID"
      endpointPlaceholder="https://graph.microsoft.com"
      endpointHelper="Informational only — cloud hosts come from Microsoft cloud settings. Tenant ID is the fallback; Per-connection tenant overrides can bind this credential ID to a separate directory."
      componentType="entra-tenant"
    />
    </>
  )
}
