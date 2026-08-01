import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Orca Security — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Orca authenticates with a single API token; the
 * connection endpoint is the tenant's regional Orca API host (default
 * api.orcasecurity.io; EU tenants use api.eu.orcasecurity.io).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Orca Security"
      appId="orca-security"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      endpointPlaceholder="api.orcasecurity.io"
      endpointHelper="Your regional Orca API host. Default (US) is api.orcasecurity.io; EU tenants use api.eu.orcasecurity.io."
    />
  )
}
