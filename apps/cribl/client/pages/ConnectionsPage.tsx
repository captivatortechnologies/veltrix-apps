import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cribl — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. A connection is a Cribl endpoint
 * over HTTPS, authenticated either by a Cribl username + password (on-prem Leader,
 * exchanged for a Bearer at /api/v1/auth/login) or a Bearer token (Cribl.Cloud);
 * `componentType="cribl-leader"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cribl"
      appId="cribl"
      componentType="cribl-leader"
      usernameLabel="Username"
      tokenLabel="Bearer token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      passwordUsernamePlaceholder="Cribl username (on-prem)"
      endpointPlaceholder="e.g. cribl.example.com:9000"
      endpointHelper="The Cribl endpoint. On-prem Leaders serve the API on 9000; Cribl.Cloud is on 443. Authenticate with a username + password (on-prem) or a Bearer token (Cribl.Cloud)."
    />
  )
}
