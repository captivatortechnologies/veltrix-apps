import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Snyk — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Snyk authenticates with an API token (a service-account token is recommended);
 * the connection endpoint is the Snyk region API host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Snyk"
      appId="snyk"
      tokenLabel="API token"
      tokenUsernamePlaceholder="not required for a Snyk token"
      endpointPlaceholder="e.g. api.snyk.io"
      endpointHelper="Snyk region API host — api.snyk.io (US), api.eu.snyk.io (EU) or api.au.snyk.io (AU)."
    />
  )
}
