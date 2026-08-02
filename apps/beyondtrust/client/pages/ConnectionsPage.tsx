import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * BeyondTrust — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is a BeyondInsight / Password Safe host over HTTPS (443) authenticated
 * by a PS-Auth API key (the token) plus a required run-as user (the username).
 * `componentType="beyondtrust-passwordsafe"` so saving a connection also registers
 * a deploy-target component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="BeyondTrust"
      appId="beyondtrust"
      componentType="beyondtrust-passwordsafe"
      tokenLabel="API key"
      usernameLabel="Run-as user"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="BeyondInsight user with API access"
      endpointPlaceholder="e.g. passwordsafe.example.com"
      endpointHelper="The BeyondInsight / Password Safe host — its HTTPS address (443). The app appends /BeyondTrust/api/public/v3. Authentication uses a PS-Auth API key (Configuration → API Registrations) plus a run-as user."
    />
  )
}
