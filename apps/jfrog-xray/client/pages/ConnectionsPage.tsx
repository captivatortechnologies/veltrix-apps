import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * JFrog Xray — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * JFrog Xray authenticates with a single Platform Access Token (Bearer); the
 * connection endpoint is the JFrog Platform host.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="JFrog Xray"
      appId="jfrog-xray"
      tokenLabel="Access token"
      usernameOptionalForToken={true}
      endpointPlaceholder="e.g. mycompany.jfrog.io"
      endpointHelper="Your JFrog Platform host — the same one used for Artifactory and Xray."
    />
  )
}
