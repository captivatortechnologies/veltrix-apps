import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Auth0 — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is an Auth0
 * tenant reached over the Management API v2 (HTTPS), authenticated by a
 * Machine-to-Machine application's Client ID (the required identifier) + Client
 * Secret (the token). `componentType="auth0-tenant"` so saving a connection also
 * registers a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Auth0"
      appId="auth0"
      componentType="auth0-tenant"
      usernameLabel="Client ID"
      tokenLabel="Client Secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Machine-to-Machine Client ID"
      endpointPlaceholder="e.g. acme.us.auth0.com"
      endpointHelper="Your Auth0 tenant domain (Management API base https://<domain>/api/v2/). Create a Machine-to-Machine application authorized for the Auth0 Management API, then attach its Client ID and Client Secret."
    />
  )
}
