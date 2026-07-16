import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * CrowdStrike Falcon — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Falcon authenticates via an OAuth2 API client: the
 * Client ID is the connection's username, the Client Secret its token.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="CrowdStrike Falcon"
      appId="crowdstrike-edr"
      usernameLabel="Client ID"
      tokenLabel="Client secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="OAuth2 API client ID"
      endpointPlaceholder="e.g. https://api.crowdstrike.com"
      endpointHelper="Falcon API base URL for your cloud region (us-1, us-2, eu-1, us-gov-1)."
    />
  )
}
