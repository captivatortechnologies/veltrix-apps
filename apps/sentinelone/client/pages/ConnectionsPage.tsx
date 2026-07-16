import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * SentinelOne — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. SentinelOne authenticates with an API token; the
 * connection endpoint is the management console URL.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="SentinelOne"
      appId="sentinelone"
      tokenLabel="API token"
      tokenUsernamePlaceholder="not required for a SentinelOne API token"
      endpointPlaceholder="e.g. https://your-console.sentinelone.net"
      endpointHelper="Your SentinelOne management console URL."
    />
  )
}
