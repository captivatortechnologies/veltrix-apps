import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * PagerDuty — Connections. Thin wrapper over the shared SDK `<ConnectionsManager>`.
 * One connection represents a PagerDuty ACCOUNT (REST API key). The API base is
 * fixed at https://api.pagerduty.com, so the endpoint is only a human label for
 * the account (e.g. its subdomain); the app authenticates with the key alone.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="PagerDuty"
      appId="pagerduty"
      componentType="pagerduty-account"
      tokenLabel="API key"
      tokenUsernamePlaceholder="Optional label for this key"
      endpointPlaceholder="e.g. acme.pagerduty.com"
      endpointHelper="Your PagerDuty account subdomain — a label only. The REST API base is fixed at https://api.pagerduty.com; the app authenticates with the API key."
    />
  )
}
