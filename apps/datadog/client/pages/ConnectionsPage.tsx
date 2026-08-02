import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Datadog — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * Datadog authenticates with two STATIC keys (no token exchange): an API key
 * (stored in the username field) and an Application key (stored in the token
 * field). The "endpoint" field holds the org's Datadog SITE (e.g.
 * "datadoghq.com", "datadoghq.eu", "us3.datadoghq.com") rather than a URL —
 * `componentType="datadog-org"` so saving a connection also registers a
 * deploy-target component the config type can deploy to.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Datadog"
      appId="datadog"
      componentType="datadog-org"
      usernameLabel="API Key"
      usernameOptionalForToken={false}
      tokenLabel="Application Key"
      tokenUsernamePlaceholder="Datadog API key"
      endpointPlaceholder="e.g. datadoghq.com"
      endpointHelper='Your Datadog site — NOT a URL. One of: datadoghq.com (US1, default), us3.datadoghq.com, us5.datadoghq.com, datadoghq.eu, ap1.datadoghq.com, ap2.datadoghq.com, ddog-gov.com. Find yours under your Datadog user menu ("Region: ...").'
    />
  )
}
