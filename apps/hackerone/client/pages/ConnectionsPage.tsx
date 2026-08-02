import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * HackerOne — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. HackerOne authenticates with HTTP
 * Basic: the API token IDENTIFIER is the username (required) and the token VALUE is
 * the secret. The API host is fixed at api.hackerone.com. `componentType` is
 * "hackerone-program" so saving a connection also registers a deploy-target
 * component the Structured Scopes config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="HackerOne"
      appId="hackerone"
      componentType="hackerone-program"
      usernameLabel="API username"
      tokenLabel="API token"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="the API token identifier (name)"
      endpointPlaceholder="api.hackerone.com"
      endpointHelper="The HackerOne API host is fixed at api.hackerone.com (https://api.hackerone.com/v1). Authentication is HTTP Basic — put the API token identifier in API username and the token value in API token (HackerOne: Organization Settings > API Tokens)."
    />
  )
}
