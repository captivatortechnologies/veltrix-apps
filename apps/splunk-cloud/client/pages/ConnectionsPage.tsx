import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Splunk Cloud — Connections. Thin wrapper over the shared SDK
 * `<ConnectionsManager>`; all the credential CRUD + Test connectivity UI lives in
 * the SDK so every app reuses it.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Splunk Cloud Platform"
      appId="splunk-cloud"
      tokenLabel="API / HEC token"
      namePlaceholder="e.g. Splunk admin API"
      endpointPlaceholder="e.g. https://myorg.splunkcloud.com"
      endpointHelper="Splunk Cloud ACS endpoint (the stack name or its URL)."
    />
  )
}
