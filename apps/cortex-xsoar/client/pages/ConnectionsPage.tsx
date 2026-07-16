import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cortex XSOAR — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. XSOAR authenticates with an API key; the connection
 * endpoint is the XSOAR server FQDN (or the Cortex API gateway host for XSOAR 8).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cortex XSOAR"
      appId="cortex-xsoar"
      tokenLabel="API key"
      tokenUsernamePlaceholder="not required for a Cortex XSOAR API key"
      endpointPlaceholder="e.g. https://xsoar.acme.com"
      endpointHelper="Your Cortex XSOAR server URL. For XSOAR 8, use the Cortex API gateway host and set the API Key ID app setting."
    />
  )
}
