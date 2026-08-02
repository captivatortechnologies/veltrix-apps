import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * runZero — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. One connection represents a
 * runZero ORGANIZATION, reached at the hosted console (console.runzero.com) and
 * authenticated by an Organization API key (Bearer). `componentType="runzero-org"`
 * so saving a connection also registers a deploy-target component the Sites config
 * type can deploy to. No username is required.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="runZero"
      appId="runzero"
      componentType="runzero-org"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this key"
      endpointPlaceholder="console.runzero.com"
      endpointHelper="The runZero console host — defaults to console.runzero.com (leave as-is for the hosted platform; set your own host for a self-hosted runZero Platform). Authentication uses an Organization API key (Account → API keys → Organization); no username is required."
    />
  )
}
