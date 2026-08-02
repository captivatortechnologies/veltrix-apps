import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Darktrace — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Darktrace
 * instance over HTTPS (443) authenticated by a DSA token pair: the PUBLIC token is
 * the credential username (required — Darktrace needs both tokens) and the PRIVATE
 * token is the secret. `componentType="darktrace"` so saving a connection also
 * registers a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Darktrace"
      appId="darktrace"
      componentType="darktrace"
      usernameLabel="Public token"
      tokenLabel="Private token"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="the DSA public token"
      endpointPlaceholder="e.g. darktrace.example.com"
      endpointHelper="The Darktrace master host — its HTTPS address (443). Authentication is a DSA token pair (Admin → System Config → API Tokens): the public token is the username, the private token is the secret."
    />
  )
}
