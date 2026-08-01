import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Delinea Secret Server — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`. Secret Server authenticates with an API user's
 * username + password via the OAuth2 password grant — use the "Username /
 * Password" auth method. The connection endpoint is the Secret Server base URL
 * (on-prem `https://<host>/SecretServer`, cloud
 * `https://<tenant>.secretservercloud.com`). `componentType="delinea-secret-server"`
 * so saving a connection also registers a deploy-target component.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Delinea Secret Server"
      appId="delinea-secret-server"
      componentType="delinea-secret-server"
      usernameLabel="Username"
      passwordUsernamePlaceholder="Secret Server API user"
      tokenLabel="API token (not used)"
      endpointPlaceholder="e.g. https://vault.example.com/SecretServer"
      endpointHelper="The Secret Server base URL — on-prem https://<host>/SecretServer, cloud https://<tenant>.secretservercloud.com. Use the Username / Password auth method; the app runs the OAuth2 password grant against <base>/oauth2/token."
    />
  )
}
