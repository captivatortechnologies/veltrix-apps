import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cybereason — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Cybereason
 * tenant over HTTPS authenticated by a username + password (session-cookie login).
 * `componentType="cybereason-tenant"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cybereason"
      appId="cybereason"
      componentType="cybereason-tenant"
      usernameLabel="Username"
      passwordUsernamePlaceholder="e.g. api-user@acme.com"
      endpointPlaceholder="e.g. acme.cybereason.net"
      endpointHelper="Your Cybereason tenant URL (https://<tenant>.cybereason.net). Choose password auth and enter the account username + password; the app logs in for a JSESSIONID session cookie."
    />
  )
}
