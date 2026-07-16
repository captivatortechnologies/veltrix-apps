import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Rapid7 InsightVM — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. InsightVM authenticates with a Security Console
 * username + password (HTTP Basic) — use the "Username / Password" auth method.
 * The connection endpoint is the console host:3780.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Rapid7 InsightVM"
      appId="rapid7"
      usernameLabel="Console username"
      passwordUsernamePlaceholder="InsightVM console username"
      tokenLabel="API token (not used)"
      endpointPlaceholder="e.g. console.example.com:3780"
      endpointHelper="Security Console host; port 3780 is assumed when omitted. Use the Username / Password auth method."
    />
  )
}
