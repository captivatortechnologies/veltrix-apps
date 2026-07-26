import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * VMware Carbon Black Cloud — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Carbon Black authenticates with an API key: the API ID
 * goes in the username field and the API Secret Key in the secret field (the app
 * sends them as X-Auth-Token: secret/id). Saving a connection also registers the
 * carbon-black deploy target. The region base URL and Org Key are set in the
 * app's settings.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="VMware Carbon Black"
      appId="carbon-black"
      usernameLabel="API ID"
      usernameOptionalForToken={false}
      tokenLabel="API Secret Key"
      tokenUsernamePlaceholder="Carbon Black API ID"
      endpointPlaceholder="https://defense.conferdeploy.net"
      endpointHelper="Informational only — set the region Base URL and Org Key in the app's settings."
      componentType="carbon-black"
    />
  )
}
