import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Check Point — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. The Management API accepts EITHER an administrator
 * username + password OR a standalone API key (no username needed) — the
 * API key auth method is preferred by `resolveCheckpointCredential` when
 * present. Saving a connection also registers the checkpoint-management
 * deploy target, so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Check Point"
      appId="checkpoint"
      componentType="checkpoint-management"
      usernameLabel="Username"
      tokenLabel="API key"
      usernameOptionalForToken={true}
      passwordUsernamePlaceholder="the Check Point administrator username"
      endpointPlaceholder="e.g. mgmt.example.com"
      endpointHelper="The Check Point Security Management Server hostname — the same host you point SmartConsole at."
    />
  )
}
