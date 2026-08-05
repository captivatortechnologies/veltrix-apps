import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Ping Identity - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. PingOne authenticates with a worker application's
 * OAuth2 client_credentials grant: the worker Client ID goes in the username
 * field and the Client Secret in the secret field. The "endpoint" is the
 * PingOne Environment ID this connection targets (the data-residency region
 * is a separate app setting, since it cannot be derived from the id alone).
 * Saving a connection also registers the pingone-environment deploy target
 * (its config types target componentTypes: [pingone-environment]), so Deploy
 * is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Ping Identity"
      appId="ping-identity"
      usernameLabel="Worker Client ID"
      usernameOptionalForToken={false}
      tokenLabel="Worker Client Secret"
      tokenUsernamePlaceholder="Worker application Client ID"
      endpointPlaceholder="e.g. 12345678-90ab-cdef-1234-567890abcdef"
      endpointHelper="Your PingOne Environment ID (Environments > <env> > Properties). Set the matching region in the app's PingOne Region setting."
      componentType="pingone-environment"
    />
  )
}
