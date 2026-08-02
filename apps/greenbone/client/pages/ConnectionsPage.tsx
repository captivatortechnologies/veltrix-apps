import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Greenbone — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Greenbone
 * gvmd manager reached over GMP (XML over a TLS socket, default 9390) authenticated
 * by a username + password (the manager offers Password auth by default);
 * `componentType="greenbone"` so saving a connection also registers a deploy-target
 * component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Greenbone"
      appId="greenbone"
      componentType="greenbone"
      usernameLabel="Username"
      usernameOptionalForToken={false}
      passwordUsernamePlaceholder="Greenbone / GMP username"
      endpointPlaceholder="e.g. gvmd.example.com"
      endpointHelper="The Greenbone gvmd host reached over GMP (XML over TLS, default port 9390 — set in this app's settings). Authentication uses the GMP username and password (the same as the Greenbone web UI)."
    />
  )
}
