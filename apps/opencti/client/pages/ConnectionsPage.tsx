import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * OpenCTI — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is an OpenCTI
 * instance over HTTPS authenticated by an API token (no username);
 * `componentType="opencti-platform"` so saving a connection also registers a
 * deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="OpenCTI"
      appId="opencti"
      componentType="opencti-platform"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this token"
      endpointPlaceholder="e.g. opencti.example.com"
      endpointHelper="The OpenCTI instance host — its HTTPS address. Authentication uses your OpenCTI API token (Profile → API access); no username is required."
    />
  )
}
