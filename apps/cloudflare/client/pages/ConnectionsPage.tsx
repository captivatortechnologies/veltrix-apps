import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cloudflare — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Cloudflare authenticates with a single API token; the
 * connection endpoint is the zone (apex) domain the token manages.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cloudflare"
      appId="cloudflare"
      tokenLabel="API token"
      tokenUsernamePlaceholder="not required for a Cloudflare API token"
      endpointPlaceholder="e.g. example.com"
      endpointHelper="Your Cloudflare zone (apex) domain — the zone this token manages."
    />
  )
}
