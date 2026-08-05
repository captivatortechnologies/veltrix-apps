import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Exabeam - Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Exabeam authenticates with an API Key's OAuth2
 * client_credentials grant: the Key goes in the username field and the
 * Secret in the token field. There is no per-tenant id to address in the URL
 * (the tenant is fully identified by the Key + region, the latter a separate
 * app setting) - the client never reads the endpoint value - but the
 * platform still requires a non-blank endpoint to register the
 * exabeam-tenant deploy-target component that Deploy needs, so any short
 * label (e.g. the tenant name) works.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Exabeam"
      appId="exabeam"
      usernameLabel="API Key"
      usernameOptionalForToken={false}
      tokenLabel="API Key Secret"
      tokenUsernamePlaceholder="Exabeam API Key"
      endpointPlaceholder="e.g. acme-corp (any label - not read by the app)"
      endpointHelper="Not used in API calls - Exabeam has no per-tenant id in the URL. Any non-blank label registers the deploy target; set the tenant's actual region in the app's Region setting."
      componentType="exabeam-tenant"
    />
  )
}
