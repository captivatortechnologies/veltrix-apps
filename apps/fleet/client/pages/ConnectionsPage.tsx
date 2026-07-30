import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Fleet — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is the Fleet
 * server over HTTPS, authenticated with a Fleet API token;
 * `componentType="fleet-server"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Fleet"
      appId="fleet"
      componentType="fleet-server"
      tokenLabel="API token"
      usernameOptionalForToken
      endpointPlaceholder="e.g. fleet.example.com"
      endpointHelper="The Fleet server host — its HTTPS address (fleetdm default 8080; hosted commonly 443). Authenticate with a Fleet API token."
    />
  )
}
