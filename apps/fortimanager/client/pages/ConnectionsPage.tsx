import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * FortiManager — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. FortiManager authenticates with an admin username +
 * password over JSON-RPC. Saving a connection also registers the fortimanager
 * deploy target, so Deploy is enabled. The FortiManager host and ADOM are set
 * in the app's settings.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="FortiManager"
      appId="fortimanager"
      usernameLabel="Admin username"
      usernameOptionalForToken={false}
      tokenLabel="Password"
      tokenUsernamePlaceholder="FortiManager admin username"
      endpointPlaceholder="fmg.example.com"
      endpointHelper="Informational only — set the FortiManager host and ADOM in the app's settings."
      componentType="fortimanager"
    />
  )
}
