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
      componentType="cloudflare-zone"
      tokenLabel="API token"
      usernameLabel="Account ID"
      tokenUsernamePlaceholder="e.g. f9fa6ce8b0f2b91f8635eedde085b094 — required for account-scoped tokens"
      endpointPlaceholder="e.g. example.com"
      endpointHelper="Your Cloudflare zone (apex) domain — the zone this token manages."
    />
  )
}
