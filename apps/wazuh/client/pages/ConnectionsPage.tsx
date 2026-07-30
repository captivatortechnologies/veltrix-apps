import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Wazuh — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is the Wazuh
 * manager REST API over HTTPS (55000); `componentType="manager"` so saving a
 * connection also registers a deploy-target component the config types deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Wazuh"
      appId="wazuh"
      componentType="manager"
      usernameLabel="API username"
      passwordUsernamePlaceholder="the Wazuh API username"
      endpointPlaceholder="e.g. manager.example.com:55000"
      endpointHelper="The Wazuh manager REST API host and port (default 55000). The app authenticates against /security/user/authenticate to obtain a bearer token."
    />
  )
}
