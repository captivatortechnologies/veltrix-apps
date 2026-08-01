import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Sumo Logic — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Sumo Logic
 * deployment over HTTPS authenticated with an Access ID (username) + Access Key
 * (the secret). `componentType="sumo-logic-org"` so saving a connection also
 * registers a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Sumo Logic"
      appId="sumo-logic"
      componentType="sumo-logic-org"
      usernameLabel="Access ID"
      tokenLabel="Access Key"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="your Sumo Logic Access ID"
      endpointPlaceholder="e.g. api.us2.sumologic.com"
      endpointHelper="Your Sumo Logic deployment's API endpoint host (US1 = api.sumologic.com; other regions e.g. api.us2.sumologic.com, api.eu.sumologic.com). Authentication uses an Access ID + Access Key (Manage → Security → Access Keys)."
    />
  )
}
