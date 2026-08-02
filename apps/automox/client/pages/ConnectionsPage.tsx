import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Automox — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Automox authenticates with a Bearer API key against a FIXED base URL
 * (https://console.automox.com/api). Almost every endpoint also requires the
 * tenant's numeric Organization ID as the `o` query parameter — carried here on
 * the required username field. Saving a connection registers an `automox-org`
 * deploy target so the Policies config type can deploy.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Automox"
      appId="automox"
      componentType="automox-org"
      usernameLabel="Organization ID"
      tokenLabel="API key"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="e.g. 9999"
      endpointPlaceholder="console.automox.com"
      endpointHelper="Automox uses a fixed API endpoint (https://console.automox.com/api). Generate an API key in the Automox Console under Settings > API Keys, and find your numeric Organization ID in the console URL or via GET /orgs."
    />
  )
}
