import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Sophos Central — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Sophos Central authenticates via an OAuth2
 * client-credentials service principal: the Client ID is the connection's
 * username, the Client Secret its token. There is no per-tenant endpoint to
 * configure — the app discovers the tenant's data-region API host
 * automatically via the Who-Am-I API, so the endpoint field is only a human
 * label.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Sophos Central"
      appId="sophos-central"
      componentType="sophos-tenant"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="OAuth2 service principal Client ID"
      endpointPlaceholder="e.g. Acme Corp - Sophos Central"
      endpointHelper="A label for your Sophos Central tenant. The API host is discovered automatically via the Who-Am-I API; the app authenticates with the Client ID / Client Secret alone."
    />
  )
}
