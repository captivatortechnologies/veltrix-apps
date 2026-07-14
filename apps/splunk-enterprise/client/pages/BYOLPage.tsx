import React from 'react'
import { ByolInfrastructureManager } from '@veltrixsecops/app-sdk/byol'

/**
 * Splunk Enterprise — BYOL infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/form/lifecycle UI (Provider
 * + region pickers, environment tags, deployment topology) lives in the SDK so
 * any app can reuse it; the data stays app-owned in this app's DB + server.
 */
export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/splunk-enterprise/byol"
      title="BYOL Splunk Infrastructure"
    />
  )
}
