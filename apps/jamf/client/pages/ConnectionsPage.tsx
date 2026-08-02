import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Jamf — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Jamf Pro authenticates with an API-only account's username + password
 * (exchanged in-process for a short-lived Bearer token); the connection
 * endpoint is the Jamf Pro server itself, also registered as the
 * "jamf-pro-server" deploy-target component.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Jamf"
      appId="jamf"
      usernameLabel="Username"
      passwordUsernamePlaceholder="e.g. svc_veltrix"
      endpointPlaceholder="e.g. https://yourcompany.jamfcloud.com"
      endpointHelper="Your Jamf Pro server (Jamf Cloud hostname, or an on-prem FQDN)."
      componentType="jamf-pro-server"
    />
  )
}
