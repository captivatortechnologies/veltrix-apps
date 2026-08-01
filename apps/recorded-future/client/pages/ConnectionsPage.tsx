import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Recorded Future — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is the Recorded Future cloud reached over HTTPS at a fixed API host
 * (api.recordedfuture.com by default), authenticated by an API token (the
 * credential token; sent as `X-RFToken`). `componentType` is
 * "recorded-future-cloud" so saving a connection also registers a deploy-target
 * component the Watch Lists config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Recorded Future"
      appId="recorded-future"
      componentType="recorded-future-cloud"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      endpointPlaceholder="api.recordedfuture.com"
      endpointHelper="The Recorded Future API host. Defaults to api.recordedfuture.com — override only for a regional / dedicated cloud. Authentication is an API token sent verbatim in the X-RFToken header (request one from support.recordedfuture.com > Requesting API Tokens)."
    />
  )
}
