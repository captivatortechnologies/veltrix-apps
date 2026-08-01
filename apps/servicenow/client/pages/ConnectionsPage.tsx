import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * ServiceNow — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route.
 * ServiceNow authenticates with an integration-user username + password (HTTP
 * Basic) against the instance's Table API. The connection endpoint is the
 * instance address (e.g. dev12345.service-now.com); `componentType`
 * ="servicenow-instance" so saving a connection also registers a deploy-target
 * component the config types can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="ServiceNow"
      appId="servicenow"
      componentType="servicenow-instance"
      usernameLabel="ServiceNow username"
      usernameOptionalForToken={false}
      passwordUsernamePlaceholder="integration user name"
      tokenLabel="API token (not used)"
      endpointPlaceholder="e.g. dev12345.service-now.com"
      endpointHelper="Your ServiceNow instance address. Use the Username / Password auth method with a dedicated integration user (scoped roles, API access enabled)."
    />
  )
}
