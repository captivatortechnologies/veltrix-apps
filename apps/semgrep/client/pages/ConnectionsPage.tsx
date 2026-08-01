import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Semgrep — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Semgrep authenticates with a single API token (Bearer) against a FIXED base URL
 * (https://semgrep.dev/api/v1) — there is no region or tenant host, so the
 * endpoint is informational (semgrep.dev) and the tenant is selected by the
 * "Deployment Slug" app setting. `componentType` is "semgrep-deployment" so
 * saving a connection also registers a deploy-target component the Project
 * Settings config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Semgrep"
      appId="semgrep"
      componentType="semgrep-deployment"
      tokenLabel="API token"
      tokenUsernamePlaceholder="not required for a Semgrep token"
      endpointPlaceholder="semgrep.dev"
      endpointHelper="Semgrep is reached at the fixed base URL https://semgrep.dev/api/v1 — leave the endpoint as semgrep.dev. Authentication is a Bearer API token (Semgrep AppSec Platform: Settings > Tokens). Set your deployment slug in the app's Deployment Slug setting."
    />
  )
}
