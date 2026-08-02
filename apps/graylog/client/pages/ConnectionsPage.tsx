import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Graylog — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`,
 * pointed at this app's connectivity-test route. The connection is a Graylog node
 * over its REST API, authenticated by HTTP Basic — either a Graylog user
 * (username + password) or an access token used as the username with the literal
 * password `token`. Pick the "access token" method to store a token (sent as
 * `token:token`), or the password method for a user. `componentType="graylog"` so
 * saving a connection also registers a deploy-target component the config types can
 * deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Graylog"
      appId="graylog"
      componentType="graylog"
      usernameLabel="Username"
      tokenLabel="Access token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="not required for an access token"
      passwordUsernamePlaceholder="Graylog username"
      endpointPlaceholder="e.g. graylog.example.com or http://graylog.example.com:9000"
      endpointHelper="The Graylog node — its REST API address. The default REST port is 9000; include a scheme (http/https) for a non-default setup. Create an access token in Graylog under System → Users → your user → Edit tokens, or use a username + password."
    />
  )
}
