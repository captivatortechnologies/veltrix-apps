import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Proofpoint (Essentials) — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Essentials authenticates with an Organization/Channel
 * Admin email + password (sent as the X-User / X-Password API headers); the
 * connection endpoint is the Essentials data-region stack host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Proofpoint Essentials"
      appId="proofpoint"
      usernameLabel="Admin email"
      passwordUsernamePlaceholder="e.g. admin@yourdomain.com"
      endpointPlaceholder="e.g. us1.proofpointessentials.com"
      endpointHelper="Your Proofpoint Essentials data-region stack host (us1–us5 or eu1)."
    />
  )
}
