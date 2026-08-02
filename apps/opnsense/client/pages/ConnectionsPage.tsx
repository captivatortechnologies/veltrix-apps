import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * OPNsense — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. The OPNsense API always authenticates with an API
 * key/secret pair sent as HTTP Basic (key = username, secret = password) —
 * no separate token concept — so both auth methods on the form map onto the
 * same pair; `resolveOpnsenseCredential` reads the secret from either
 * `password` or `apiToken`. Saving a connection also registers the
 * `opnsense-firewall` deploy target, so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="OPNsense"
      appId="opnsense"
      componentType="opnsense-firewall"
      usernameLabel="API Key"
      usernameOptionalForToken={false}
      tokenLabel="API Secret"
      tokenUsernamePlaceholder="the OPNsense API key"
      passwordUsernamePlaceholder="the OPNsense API key"
      endpointPlaceholder="e.g. opnsense.example.com"
      endpointHelper="The OPNsense GUI/API hostname — the same host you reach the web interface at."
    />
  )
}
