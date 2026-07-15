import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Splunk Enterprise — BYOL infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Splunk-specific configuration links are supplied here,
 * keeping the SDK app-agnostic.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'apps', title: 'Splunk Apps', description: 'Install apps & add-ons and the .conf files they ship (indexes, roles).', configTypeId: 'apps' },
  { key: 'hec-tokens', title: 'HEC Tokens', description: 'Create HTTP Event Collector tokens, routing and allowed indexes.', configTypeId: 'hec-tokens' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/splunk-enterprise/byol"
      title="BYOL Splunk Infrastructure"
      configBase="/apps/splunk-enterprise/config"
      configLinks={CONFIG_LINKS}
    />
  )
}
