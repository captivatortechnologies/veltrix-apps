import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Axonius — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. Axonius authenticates with a
 * service-account API key + secret: the API key is the connection's username and
 * the API secret its token. `componentType="axonius"` so saving a connection also
 * registers a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Axonius"
      appId="axonius"
      componentType="axonius"
      usernameLabel="API key"
      tokenLabel="API secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Axonius API key"
      endpointPlaceholder="e.g. tenant.axonius.com"
      endpointHelper="Your Axonius tenant host — its HTTPS address (443). Create an API key + secret under your account's API Key page (a service account is required on Axonius 6.1.74+)."
    />
  )
}
