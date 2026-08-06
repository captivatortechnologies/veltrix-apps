import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * 1Password - Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. This app authenticates to a self-hosted 1Password
 * SCIM Bridge with a bearer token (no username) - the same token generated
 * for the bridge's identity-provider integration. The "endpoint" is the
 * bridge's own base URL, not a 1Password.com address.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="1Password"
      appId="onepassword"
      tokenLabel="SCIM Bridge Bearer Token"
      tokenUsernamePlaceholder="not required for a bearer token"
      endpointPlaceholder="e.g. https://scim.example.com"
      endpointHelper="Your 1Password SCIM Bridge's base URL - no trailing slash, no /scim/v2 path."
      componentType="onepassword-scim-bridge"
    />
  )
}
