import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * IBM QRadar — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * QRadar authenticates with an authorized-service token (stored in the secret
 * field, sent as the SEC header). Saving a connection also registers the
 * ibm-qradar deploy target. The console host and API version are set in the
 * app's settings.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="IBM QRadar"
      appId="ibm-qradar"
      usernameLabel="Username (not required)"
      usernameOptionalForToken={true}
      tokenLabel="Authorized-service token (SEC)"
      tokenUsernamePlaceholder="not required for a service token"
      endpointPlaceholder="qradar.example.com"
      endpointHelper="Informational only — set the console host and API version in the app's settings."
      componentType="ibm-qradar"
    />
  )
}
