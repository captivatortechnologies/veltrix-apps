import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Google Security Operations — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. SecOps authenticates with a Google service account: paste
 * the entire service-account JSON key into the secret field. Saving a connection
 * also registers the google-secops deploy target. The region, project id and
 * instance id are set in the app's settings.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Google SecOps"
      appId="google-secops"
      usernameLabel="Username (not required)"
      usernameOptionalForToken={true}
      tokenLabel="Service-account JSON key"
      tokenUsernamePlaceholder="not required for a service-account key"
      endpointPlaceholder="chronicle.googleapis.com"
      endpointHelper="Informational only — set the region, project id and instance id in the app's settings."
      componentType="google-secops"
    />
  )
}
