import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cisco Meraki — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. One connection represents a Meraki ORGANIZATION
 * (Dashboard API key). The API base is fixed at https://api.meraki.com/api/v1,
 * so the endpoint is only a human label for the organization; the app
 * authenticates with the key alone.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cisco Meraki"
      appId="cisco-meraki"
      componentType="meraki-organization"
      tokenLabel="API key"
      tokenUsernamePlaceholder="Optional label for this key"
      endpointPlaceholder="e.g. Acme Corp - Meraki"
      endpointHelper="A label for your Meraki organization. The Dashboard API base is fixed at https://api.meraki.com/api/v1; the app authenticates with the API key alone."
    />
  )
}
