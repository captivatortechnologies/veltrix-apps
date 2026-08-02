import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Illumio — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * Illumio authenticates with a PCE API key + secret over HTTP Basic auth — the
 * key is the "username" half of the pair and the secret is the "token" half.
 * Saving a connection also registers the illumio-pce deploy target, so Deploy
 * is enabled. The PCE host, port and organization ID are set in the app's
 * settings, not per-connection (a Veltrix installation manages one PCE).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Illumio"
      appId="illumio"
      componentType="illumio-pce"
      usernameLabel="API key username"
      usernameOptionalForToken={false}
      tokenLabel="API key secret"
      tokenUsernamePlaceholder="api_145a5c788e2ba897c"
      endpointPlaceholder="pce.example.com"
      endpointHelper="Informational only — set the PCE host, port and organization ID in the app's settings."
    />
  )
}
