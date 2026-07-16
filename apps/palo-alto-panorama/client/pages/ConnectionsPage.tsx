import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Palo Alto Panorama — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Panorama authenticates with a pre-generated PAN-OS API
 * key (sent as the X-PAN-KEY header) — use the "API token" auth method, no
 * username required. The connection endpoint is the Panorama management host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Palo Alto Panorama"
      appId="palo-alto-panorama"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      endpointPlaceholder="e.g. panorama.example.com"
      endpointHelper="Panorama management host (HTTPS). Store a pre-generated PAN-OS API key in the API token field — generate one with type=keygen."
    />
  )
}
