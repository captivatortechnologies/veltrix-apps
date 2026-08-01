import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Sysdig Secure — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is a Sysdig tenant addressed by its region base URL over HTTPS,
 * authenticated by a Bearer API token (no username). `componentType="sysdig-secure"`
 * so saving a connection also registers a deploy-target component the config
 * types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Sysdig Secure"
      appId="sysdig-secure"
      componentType="sysdig-secure"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="e.g. https://us2.app.sysdig.com"
      endpointHelper="Your Sysdig region base URL — the address of your Sysdig console (e.g. https://us2.app.sysdig.com; US-East default https://secure.sysdig.com). Authentication uses a Sysdig Secure API token (Settings → Sysdig Secure API); no username is required."
    />
  )
}
