import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Twingate — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Twingate authenticates with a single API key (no paired account id);
 * `componentType="twingate-network"` so saving a connection also registers a
 * deploy-target component the Resources config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Twingate"
      appId="twingate"
      componentType="twingate-network"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this key"
      endpointPlaceholder="e.g. acme or acme.twingate.com"
      endpointHelper="Your Twingate network name (find it in the URL of your Admin Console). Authentication uses an API key generated under Settings > API; no username is required."
    />
  )
}
