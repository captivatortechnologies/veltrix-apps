import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Bitdefender GravityZone — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. GravityZone authenticates with a single API key
 * (generated in the Control Center under My Account > API keys), sent as
 * HTTP Basic with the key as the username and an empty password — so only
 * the token field is used; there is no separate username.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Bitdefender GravityZone"
      appId="bitdefender-gravityzone"
      componentType="gravityzone-tenant"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      endpointPlaceholder="e.g. cloud.gravityzone.bitdefender.com"
      endpointHelper="Your GravityZone Control Center API host (cloud.gravityzone.bitdefender.com for the default Cloud console, or your on-premises/regional Control Center's hostname). The app calls https://<host>/api/v1.0/jsonrpc/<service>."
    />
  )
}
