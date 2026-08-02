import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Rubrik — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Rubrik
 * cluster over HTTPS authenticated by a SERVICE ACCOUNT: its id is the
 * connection's username, its secret the token. `componentType="rubrik-cluster"`
 * so saving a connection also registers a deploy-target component the config
 * types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Rubrik"
      appId="rubrik"
      componentType="rubrik-cluster"
      usernameLabel="Service account ID"
      tokenLabel="Secret"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Rubrik service account id (User|...)"
      endpointPlaceholder="e.g. https://rubrik.example.com"
      endpointHelper="The Rubrik cluster address (HTTPS). Authentication uses a service account (Settings → Users & Roles → Service Accounts): store its id as the username and its secret as the token."
    />
  )
}
