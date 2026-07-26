import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * SailPoint — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * ISC authenticates via OAuth2 client credentials: the Client ID goes in the
 * username field and the Client Secret in the secret field. Saving a connection
 * also registers the sailpoint-tenant deploy target, so Deploy is enabled. The
 * tenant (org name) is set separately in the app's Tenant setting.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="SailPoint"
      appId="sailpoint"
      usernameLabel="Client ID"
      usernameOptionalForToken={false}
      tokenLabel="Client secret"
      tokenUsernamePlaceholder="ISC OAuth client / PAT Client ID"
      endpointPlaceholder="https://acme.api.identitynow.com"
      endpointHelper="Informational only — the ISC API host; set the tenant (org name) in the app's Tenant setting."
      componentType="sailpoint-tenant"
    />
  )
}
