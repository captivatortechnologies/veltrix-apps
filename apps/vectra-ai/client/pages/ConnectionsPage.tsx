import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Vectra AI — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Vectra brain
 * over HTTPS (443) authenticated by a Vectra API token (no username);
 * `componentType="vectra-brain"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Vectra AI"
      appId="vectra-ai"
      componentType="vectra-brain"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="e.g. mytenant.vectra.ai"
      endpointHelper="The Vectra brain host — its HTTPS address (443). Authentication uses a Vectra API token (My Profile → API Token on a local account); no username is required."
    />
  )
}
