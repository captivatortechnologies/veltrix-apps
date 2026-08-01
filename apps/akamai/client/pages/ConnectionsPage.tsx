import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Akamai — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is an Akamai API
 * host over HTTPS (443) authenticated with EdgeGrid credentials from an `.edgerc`.
 *
 * Credential mapping (three EdgeGrid values):
 *   host (base URL) → the connection Endpoint (Akamai API host)
 *   client_token    → credential username  (usernameLabel below)
 *   access_token    → credential API token (tokenLabel below)
 *   client_secret   → credential password  (set on the credential; the true secret)
 *
 * `componentType="akamai"` so saving a connection also registers a deploy-target
 * component the Network Lists config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Akamai"
      appId="akamai"
      componentType="akamai"
      usernameLabel="Client token"
      tokenLabel="Access token"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="EdgeGrid client_token (from .edgerc)"
      endpointPlaceholder="e.g. akab-xxxxxxxxxxxxxxxx.luna.akamaiapis.net"
      endpointHelper="The Akamai API host from your .edgerc. Authentication uses EdgeGrid: store client_token as the username, access_token as the API token, and client_secret as the credential password."
    />
  )
}
