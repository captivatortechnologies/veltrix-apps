import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cisco Duo — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * Duo authenticates with an Admin API integration key + secret key: the
 * integration key goes in the username field and the secret key in the secret
 * field. Saving a connection also registers the cisco-duo deploy target, so
 * Deploy is enabled. The API hostname is set in the app's API Host setting.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cisco Duo"
      appId="cisco-duo"
      usernameLabel="Integration key"
      usernameOptionalForToken={false}
      tokenLabel="Secret key"
      tokenUsernamePlaceholder="Duo Admin API integration key"
      endpointPlaceholder="api-XXXXXXXX.duosecurity.com"
      endpointHelper="Informational only — set the API hostname in the app's API Host setting."
      componentType="cisco-duo"
    />
  )
}
