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
      tokenLabel="Splunk authentication token (not HEC)"
      endpointPlaceholder="e.g. https://splunk.internal:8089"
      endpointHelper="Use the splunkd management URL (HTTPS port 8089), not Splunk Web (8000) or HEC (8088). HEC tokens only ingest events."
    />
  )
}
