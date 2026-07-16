import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Elastic Security — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Elastic authenticates with a base64 `id:api_key`.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Elastic Security"
      appId="elastic-security"
      tokenLabel="API key"
      tokenUsernamePlaceholder="not required for an API key"
      endpointPlaceholder="e.g. https://<deployment>.kb.<region>.cloud.es.io:9243"
      endpointHelper="Kibana base URL this connection reaches."
    />
  )
}
