import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Mimecast — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * Mimecast authenticates with an API 2.0 application (OAuth2 client credentials):
 * the Client ID goes in the username field and the Client Secret in the secret
 * field. Saving a connection also registers the mimecast deploy target. The API
 * base URL is set in the app's settings (defaults to the shared gateway host).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Mimecast"
      appId="mimecast"
      usernameLabel="Client ID"
      usernameOptionalForToken={false}
      tokenLabel="Client secret"
      tokenUsernamePlaceholder="Mimecast API 2.0 Client ID"
      endpointPlaceholder="https://api.services.mimecast.com"
      endpointHelper="Informational only — the API base URL is set in the app's settings (defaults to api.services.mimecast.com)."
      componentType="mimecast"
    />
  )
}
