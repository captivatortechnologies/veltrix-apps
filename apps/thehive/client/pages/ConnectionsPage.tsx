import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * TheHive — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a TheHive
 * instance authenticated by a Bearer API key (no username);
 * `componentType="thehive"` so saving a connection also registers a deploy-target
 * component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="TheHive"
      appId="thehive"
      componentType="thehive"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this key"
      endpointPlaceholder="e.g. https://thehive.example.com or host:9000"
      endpointHelper="The TheHive instance URL — 443 behind a reverse proxy, or :9000 direct. Authentication uses a TheHive API key (user profile → API keys), sent as a Bearer token; no username is required."
    />
  )
}
