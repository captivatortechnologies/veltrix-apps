import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Aqua Security — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. The Aqua Console authenticates with a dedicated
 * Aqua user id/email + password (no separate token concept for this app) —
 * so both auth-method picker choices map to the same username/password pair;
 * the connection endpoint is the Aqua Console base URL. Saving a connection
 * also registers the `aqua-security` deploy target, so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Aqua Security"
      appId="aqua-security"
      componentType="aqua-security"
      usernameLabel="Aqua user (id/email)"
      usernameOptionalForToken={false}
      tokenLabel="Password"
      tokenUsernamePlaceholder="the Aqua user id/email"
      passwordUsernamePlaceholder="the Aqua user id/email"
      endpointPlaceholder="e.g. aqua.example.com"
      endpointHelper="The Aqua Console base URL — self-hosted or single-tenant Aqua-hosted Console."
    />
  )
}
