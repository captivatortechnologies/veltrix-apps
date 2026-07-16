import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * HashiCorp Vault — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Vault authenticates with a token (X-Vault-Token).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="HashiCorp Vault"
      appId="hashicorp-vault"
      tokenLabel="Token"
      tokenUsernamePlaceholder="not required for a Vault token"
      endpointPlaceholder="e.g. https://vault.example.com:8200"
      endpointHelper="Vault base URL this connection reaches."
    />
  )
}
