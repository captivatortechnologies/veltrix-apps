import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Cortex XDR — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Cortex XDR
 * tenant reached over HTTPS at its API FQDN, authenticated (Standard security) by
 * an API Key ID (the credential username) + API Key (the token). `componentType`
 * is "cortex-xdr-tenant" so saving a connection also registers a deploy-target
 * component the IOCs config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Cortex XDR"
      appId="cortex-xdr"
      componentType="cortex-xdr-tenant"
      usernameLabel="API Key ID"
      tokenLabel="API Key"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="the API Key ID (integer)"
      endpointPlaceholder="e.g. api-yourtenant.xdr.us.paloaltonetworks.com"
      endpointHelper="Your Cortex XDR tenant API FQDN — use Copy URL next to the key in Settings > Configurations > API Keys. Authentication uses a Standard-security API key: the API Key ID (username) and the API Key value (token)."
    />
  )
}
