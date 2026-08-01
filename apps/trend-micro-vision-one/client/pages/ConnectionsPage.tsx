import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Trend Micro Vision One — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`, pointed at this app's connectivity-test route. The
 * connection is a Trend Vision One tenant reached over HTTPS at its regional API
 * host, authenticated by a Bearer API token (no username). `componentType` is
 * "trend-vision-one-tenant" so saving a connection also registers a deploy-target
 * component the Suspicious Objects config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Trend Micro Vision One"
      appId="trend-micro-vision-one"
      componentType="trend-vision-one-tenant"
      tokenLabel="API token"
      usernameOptionalForToken={true}
      tokenUsernamePlaceholder="optional label for this key"
      endpointPlaceholder="e.g. api.xdr.trendmicro.com"
      endpointHelper="Your Trend Vision One regional API host — api.xdr.trendmicro.com (US), api.eu.xdr.trendmicro.com (EU), api.sg.xdr.trendmicro.com (Singapore), etc. Authentication uses a Bearer API key generated in the Vision One console under Administration > API Keys; no username is required."
    />
  )
}
