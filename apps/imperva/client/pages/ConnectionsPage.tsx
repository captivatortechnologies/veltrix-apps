import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Imperva — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is the Imperva
 * Cloud WAF (Incapsula) management API v1, reached over HTTPS (443) and
 * authenticated with an API ID + API key.
 *
 * Credential mapping (two values):
 *   API ID  → credential username  (usernameLabel below)
 *   API key → credential API token (tokenLabel below)
 *
 * The endpoint is OPTIONAL — it defaults to https://my.imperva.com/api/prov/v1 and
 * may be left blank; set it only to override the management host.
 * `componentType="imperva"` so saving a connection also registers a deploy-target
 * component the ACL Rules config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Imperva"
      appId="imperva"
      componentType="imperva"
      usernameLabel="API ID"
      tokenLabel="API key"
      usernameOptionalForToken={false}
      tokenUsernamePlaceholder="Imperva API ID"
      endpointPlaceholder="https://my.imperva.com/api/prov/v1 (default — leave blank)"
      endpointHelper="The Imperva Cloud WAF management API base URL. Leave blank to use the default (https://my.imperva.com/api/prov/v1). Authentication uses an API ID (username) and API key (API token) from the Cloud Security Console."
    />
  )
}
