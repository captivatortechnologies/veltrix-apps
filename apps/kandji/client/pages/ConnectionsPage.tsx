import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Kandji — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Kandji authenticates with a single tenant-scoped Bearer API token; the
 * connection endpoint IS the Kandji tenant API URL itself (e.g.
 * https://yourcompany.api.kandji.io), also registered as the "kandji-tenant"
 * deploy-target component — the same "endpoint is the host" pattern
 * apps/okta-identity and apps/pagerduty use.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Kandji"
      appId="kandji"
      componentType="kandji-tenant"
      tokenLabel="API token"
      tokenUsernamePlaceholder="Optional label for this token"
      endpointPlaceholder="e.g. https://yourcompany.api.kandji.io"
      endpointHelper="Your Kandji tenant API URL from Settings > Access — e.g. yourcompany.api.kandji.io (US) or yourcompany.api.eu.kandji.io (EU)."
    />
  )
}
