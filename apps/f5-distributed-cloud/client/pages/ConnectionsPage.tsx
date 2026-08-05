import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * F5 Distributed Cloud - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. F5 XC authenticates with an "API Token" credential -
 * a single bearer secret (no client id/username pairing), sent as
 * `Authorization: APIToken <token>` on every request. The "endpoint" is the
 * tenant's F5 XC Console hostname (e.g. "acmecorp.console.ves.volterra.io").
 * Saving a connection also registers the f5xc-namespace deploy target (its
 * config types target componentTypes: [f5xc-namespace]), so Deploy is
 * enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="F5 Distributed Cloud"
      appId="f5-distributed-cloud"
      usernameLabel="Username"
      usernameOptionalForToken={true}
      tokenLabel="API Token"
      tokenUsernamePlaceholder="Not required for API Token auth"
      endpointPlaceholder="e.g. acmecorp.console.ves.volterra.io"
      endpointHelper="Your F5 Distributed Cloud tenant Console hostname (shown in the browser address bar when logged into console.ves.volterra.io). Set the namespace this connection manages in the app's F5 XC Namespace setting."
      componentType="f5xc-namespace"
    />
  )
}
