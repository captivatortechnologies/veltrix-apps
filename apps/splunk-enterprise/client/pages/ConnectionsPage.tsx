import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Splunk Enterprise — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Splunk Enterprise"
      appId="splunk-enterprise"
      tokenLabel="API / HEC token"
      endpointPlaceholder="e.g. https://splunk.internal:8089"
      endpointHelper="Splunk management API base URL (typically port 8089)."
    />
  )
}
