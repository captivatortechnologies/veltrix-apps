import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * MISP — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a MISP instance
 * over HTTPS (443) authenticated by an automation key (no username);
 * `componentType="misp-core"` so saving a connection also registers a deploy-target
 * component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="MISP"
      appId="misp"
      componentType="misp-core"
      tokenLabel="Automation key"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this key"
      endpointPlaceholder="e.g. misp.example.com"
      endpointHelper="The MISP instance host — its HTTPS address (443). Authentication uses a MISP automation key (Administration → List Auth Keys); no username is required."
    />
  )
}
