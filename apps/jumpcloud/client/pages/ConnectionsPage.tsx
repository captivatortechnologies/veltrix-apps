import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * JumpCloud — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * JumpCloud authenticates with an API key sent as the `x-api-key` header against a
 * FIXED base URL (https://console.jumpcloud.com/api). Multi-tenant (MTP) admins
 * additionally set an Org ID (sent as `x-org-id`) — carried here on the optional
 * username field. Saving a connection registers a `jumpcloud-org` deploy target so
 * the User Groups config type can deploy.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="JumpCloud"
      appId="jumpcloud"
      componentType="jumpcloud-org"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional Org ID (multi-tenant admins only)"
      endpointPlaceholder="console.jumpcloud.com"
      endpointHelper="JumpCloud uses a fixed API endpoint (https://console.jumpcloud.com/api). Authenticate with an API key from the Admin Portal (your account name → My API Key). Leave the Org ID blank unless you are a multi-tenant (MTP) admin managing multiple organizations."
    />
  )
}
