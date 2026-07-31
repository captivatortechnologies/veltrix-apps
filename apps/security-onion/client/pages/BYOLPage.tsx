import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Security Onion — BYOL grid infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Security-Onion-specific configuration links and grid
 * topology are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's two node tiers — Search nodes
 * (Elasticsearch data / search-node) and Heavy nodes (heavy-node search tier;
 * see lib/byolTopology.ts for the full grid mapping) — so the form, list table
 * and detail view render Security-Onion-shaped labels instead of the SDK's
 * former Splunk-only Indexers/Search-heads pair.
 *
 * Unlike Splunk there is NO version picker — Security Onion is open source, so
 * `versionOptions` is omitted (the SDK form hides the picker for an empty list)
 * and the server carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'suricata-rules', title: 'Suricata Rules', description: 'Enable or disable Suricata NIDS rules by SID across the grid.', configTypeId: 'suricata-rules' },
  { key: 'firewall-access', title: 'Firewall Access', description: 'Analyst/host access to Security Onion firewall host groups.', configTypeId: 'firewall-access' },
  { key: 'soc-users', title: 'SOC Users', description: 'Enable or disable Security Onion Console users by email.', configTypeId: 'soc-users' },
  { key: 'detections', title: 'Detection Engine Rules', description: 'Elastic/Kibana Detection Engine rules — KQL, severity and risk score.', configTypeId: 'detections' },
  { key: 'zeek-config', title: 'Zeek Configuration', description: 'Enable or disable Zeek log types / analyzers across the grid.', configTypeId: 'zeek-config' },
  { key: 'elastic-ilm', title: 'Elasticsearch ILM', description: 'Index lifecycle policies — hot rollover and total retention.', configTypeId: 'elastic-ilm' },
]

// The two Security Onion grid deployment types.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (eval / standalone)' },
  { value: 'distributed', label: 'Distributed grid' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/security-onion/byol"
      title="BYOL Security Onion Grid"
      configBase="/apps/security-onion/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Security Onion',
        tiers: [
          { key: 'search', label: 'Search nodes', min: 2, help: 'Elasticsearch data / search nodes.' },
          { key: 'heavy', label: 'Heavy nodes', min: 1, help: 'Heavy nodes (search-tier processing + storage).' },
        ],
        infoTooltip:
          'Provision and manage a dedicated Security Onion grid (bring-your-own-license): define the topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
