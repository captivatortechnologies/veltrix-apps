import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Akeyless - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Akeyless authenticates with an API Key auth method:
 * the Access ID goes in the username field and the Access Key in the secret
 * field. The platform requires a non-empty endpoint to register this
 * connection's akeyless-account deploy target (componentType below), so
 * "endpoint" is always the Akeyless API host - "api.akeyless.io" for the
 * public SaaS control plane, or a private Akeyless Gateway URL for accounts
 * managed through a self-hosted Gateway.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Akeyless"
      appId="akeyless"
      usernameLabel="Access ID"
      usernameOptionalForToken={false}
      tokenLabel="Access Key"
      tokenUsernamePlaceholder="Access ID"
      endpointPlaceholder="api.akeyless.io, or your Gateway URL"
      endpointHelper="The Akeyless API host - enter 'api.akeyless.io' for the public SaaS control plane, or your private Gateway's URL."
      componentType="akeyless-account"
    />
  )
}
