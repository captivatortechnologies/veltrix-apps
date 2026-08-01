import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cisco Umbrella — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Umbrella authenticates with an OAuth2 API key + secret:
 * the API key goes in the username field and the API secret in the secret field.
 * Saving a connection also registers the cisco-umbrella deploy target, so Deploy
 * is enabled. The base URL is fixed to https://api.umbrella.com.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cisco Umbrella"
      appId="cisco-umbrella"
      usernameLabel="API Key"
      usernameOptionalForToken={false}
      tokenLabel="API Secret"
      tokenUsernamePlaceholder="Umbrella API key"
      endpointPlaceholder="https://api.umbrella.com"
      endpointHelper="Informational only — the Umbrella API base URL is fixed at https://api.umbrella.com."
      componentType="cisco-umbrella"
    />
  )
}
