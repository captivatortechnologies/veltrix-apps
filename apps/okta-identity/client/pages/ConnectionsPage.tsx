import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Okta — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Okta authenticates with an SSWS API token.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Okta"
      appId="okta-identity"
      tokenLabel="API token (SSWS)"
      tokenUsernamePlaceholder="not required for an SSWS token"
      endpointPlaceholder="e.g. https://dev-12345.okta.com"
      endpointHelper="Okta org domain this connection reaches."
    />
  )
}
