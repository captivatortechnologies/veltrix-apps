import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Qualys — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Qualys authenticates with an account username + password (HTTP Basic) to the
 * subscription's platform API server. The connection endpoint is the Qualys
 * platform URL (Help > About), e.g. qualysapi.qg2.apps.qualys.com.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Qualys"
      appId="qualys"
      usernameLabel="Qualys username"
      usernameOptionalForToken={false}
      passwordUsernamePlaceholder="Qualys account username"
      tokenLabel="API token (not used)"
      endpointPlaceholder="e.g. qualysapi.qg2.apps.qualys.com"
      endpointHelper="Your Qualys platform API server (Help > About). Use the Username / Password auth method."
    />
  )
}
