import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cato Networks - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Cato authenticates with a single API Key (Administration
 * > API Keys in the Cato Management Application), stored in the credential's
 * secret field - there is no username. The "endpoint" is the Cato Account ID
 * this connection targets (used both as the `x-account-id` header and the
 * `accountId` GraphQL argument on every request). Saving a connection also
 * registers the cato-account deploy target (its config types target
 * componentTypes: [cato-account]), so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cato Networks"
      appId="cato-networks"
      usernameOptionalForToken={true}
      tokenLabel="Cato API Key"
      tokenUsernamePlaceholder="Not used - Cato authenticates with the API Key alone"
      endpointPlaceholder="e.g. 12345"
      endpointHelper="Your Cato Account ID (Cato Management Application, top-right account switcher, or Administration > API Keys)."
      componentType="cato-account"
    />
  )
}
