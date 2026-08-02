import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * authentik — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a self-hosted
 * authentik instance reached over HTTPS, authenticated by a single static API
 * token (no username). `componentType="authentik-server"` so saving a connection
 * also registers a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="authentik"
      appId="authentik"
      componentType="authentik-server"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="e.g. authentik.example.com"
      endpointHelper="Your authentik instance host. Authentication uses a static API token (Directory > Tokens) sent as Authorization: Bearer <token>; no username is required."
    />
  )
}
