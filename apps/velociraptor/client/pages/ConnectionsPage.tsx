import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Velociraptor — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is a Velociraptor server reached over the gRPC API (mutual TLS); the
 * secret is the api-client config bundle produced by
 * `velociraptor config api_client` (CA cert + client cert + client key +
 * api_connection_string). `componentType="velociraptor-server"` so saving a
 * connection also registers a deploy-target component the config types deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Velociraptor"
      appId="velociraptor"
      componentType="velociraptor-server"
      tokenLabel="API client config"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this api-client"
      endpointPlaceholder="e.g. velociraptor.example.com:8001"
      endpointHelper="The Velociraptor API server address (host:port from api_connection_string). Authentication is the api-client config bundle from `velociraptor config api_client` — paste the whole YAML (CA cert, client cert, client key) into the API client config field."
    />
  )
}
