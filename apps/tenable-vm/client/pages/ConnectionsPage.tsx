import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Tenable Vulnerability Management — Connections. Thin wrapper over the shared
 * SDK `<ConnectionsManager>`. Tenable authenticates with an access key + secret
 * key pair: the access key is the connection's username, the secret key its token.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Tenable Vulnerability Management"
      appId="tenable-vm"
      usernameLabel="Access key"
      tokenLabel="Secret key"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Tenable access key"
      endpointPlaceholder="e.g. https://cloud.tenable.com"
      endpointHelper="Tenable API base URL (defaults to cloud.tenable.com)."
    />
  )
}
