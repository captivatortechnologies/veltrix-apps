import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Keycloak — Connections. Thin wrapper over the shared SDK <ConnectionsManager>.
 * Keycloak authenticates via OAuth2 client-credentials against an admin
 * service-account client: the admin client-id goes in the username field and the
 * client secret in the secret field. (An admin username/password grant is also
 * supported — put the admin username in username and the password in the
 * password field of the credential.) Saving a connection also registers the
 * keycloak-realm deploy target, so Deploy is enabled. The managed realm is set
 * separately in the app's "Managed realm" setting (defaults to master).
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Keycloak"
      appId="keycloak"
      componentType="keycloak-realm"
      usernameLabel="Admin client-id"
      usernameOptionalForToken={false}
      tokenLabel="Client secret"
      tokenUsernamePlaceholder="admin service-account client-id (e.g. veltrix-admin)"
      endpointPlaceholder="e.g. https://keycloak.example.com"
      endpointHelper="The Keycloak server base URL. Authentication obtains an admin token via OAuth2 client-credentials (admin client-id + secret). The managed realm and token realm are set in the app's settings (both default to master)."
    />
  )
}
