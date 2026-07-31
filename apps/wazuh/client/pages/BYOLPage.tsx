import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Wazuh — BYOL cluster infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Wazuh-specific configuration links and cluster
 * topology options are supplied here, keeping the SDK app-agnostic.
 *
 * Like Security Onion there is NO version picker — Wazuh is open source, so
 * `versionOptions` is omitted (the SDK form hides the picker for an empty list)
 * and the server carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'cdb-lists', title: 'CDB Lists', description: 'Wazuh CDB lists (constant databases) — key:value lookup files backing blocklists/allowlists.', configTypeId: 'cdb-lists' },
  { key: 'agent-groups', title: 'Agent Groups', description: 'Wazuh agent groups and their shared agent.conf.', configTypeId: 'agent-groups' },
  { key: 'custom-rules', title: 'Custom Rules', description: 'Wazuh custom ruleset files (etc/rules) — a manager restart activates the change.', configTypeId: 'custom-rules' },
  { key: 'custom-decoders', title: 'Custom Decoders', description: 'Wazuh custom decoder files (etc/decoders) — a manager restart activates the change.', configTypeId: 'custom-decoders' },
]

// The two Wazuh cluster topologies. Node tiers (Indexers / Manager workers) are
// declared below via the `topology` prop; the server maps their counts to the
// full Wazuh cluster (indexer nodes / manager workers / dashboards — see
// lib/byolTopology.ts).
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (eval / standalone)' },
  { value: 'distributed', label: 'Distributed cluster' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/wazuh/byol"
      title="BYOL Wazuh Cluster"
      configBase="/apps/wazuh/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Wazuh',
        tiers: [
          { key: 'indexer', label: 'Indexers', min: 3, help: 'Wazuh indexer (OpenSearch) data tier.' },
          { key: 'worker', label: 'Manager workers', min: 2, help: 'Wazuh manager worker nodes.' },
        ],
        infoTooltip:
          'Provision and manage a dedicated Wazuh cluster (bring-your-own-license): define the topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
