import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Tanium — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Tanium Server
 * / Tanium Cloud instance over HTTPS (443) authenticated by an API token OR a
 * username + password (session login). `componentType="tanium-server"` so saving a
 * connection also registers a deploy-target component the config types deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Tanium"
      appId="tanium"
      componentType="tanium-server"
      usernameLabel="Username"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      passwordUsernamePlaceholder="Tanium username"
      endpointPlaceholder="e.g. my-tanium.cloud.tanium.com"
      endpointHelper="The Tanium Server / Tanium Cloud host — its HTTPS address (443). Authenticate with an API token (Administration → Permissions → API Tokens), or a Tanium username and password."
    />
  )
}
