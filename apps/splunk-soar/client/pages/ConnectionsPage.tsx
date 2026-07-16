import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Splunk SOAR — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. SOAR accepts an automation (ph-auth) token or basic
 * username/password.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Splunk SOAR"
      appId="splunk-soar"
      tokenLabel="Automation token"
      endpointPlaceholder="e.g. https://soar.example.com"
      endpointHelper="Splunk SOAR base URL this connection reaches."
    />
  )
}
