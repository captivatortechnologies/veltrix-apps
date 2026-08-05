import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * OneLogin - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. OneLogin authenticates with an API Credential's
 * OAuth2 client_credentials grant: the Client ID goes in the username field
 * and the Client Secret in the secret field. The "endpoint" is the OneLogin
 * account's subdomain (or full domain) this connection targets - OneLogin has
 * no separate region/data-center host to select (unlike Okta/PingOne); the
 * subdomain IS the account. Saving a connection also registers the
 * onelogin-account deploy target (its config types target componentTypes:
 * [onelogin-account]), so Deploy is enabled.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="OneLogin"
      appId="onelogin"
      usernameLabel="API Credential Client ID"
      usernameOptionalForToken={false}
      tokenLabel="API Credential Client Secret"
      tokenUsernamePlaceholder="API Credential Client ID"
      endpointPlaceholder="e.g. acme or acme.onelogin.com"
      endpointHelper="Your OneLogin subdomain (the same address you use to log in) - e.g. 'acme' or 'acme.onelogin.com'."
      componentType="onelogin-account"
    />
  )
}
