import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink, type ByolTopology } from '@veltrixsecops/app-sdk/byol'

/**
 * Fleet — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Fleet-specific configuration links and stack topology
 * are supplied here, keeping the SDK app-agnostic.
 *
 * Like Security Onion there is NO version picker — Fleet is open source, so
 * `versionOptions` is omitted (the SDK form hides the picker for an empty list)
 * and the server carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'queries', title: 'Saved Queries', description: 'Author Fleet saved osquery queries — SQL, schedule interval and target platform.', configTypeId: 'queries' },
  { key: 'policies', title: 'Global Policies', description: 'Fleet global compliance policies — pass/fail osquery checks, resolution and criticality.', configTypeId: 'policies' },
  { key: 'labels', title: 'Labels', description: 'Fleet dynamic labels — the osquery selector that assigns hosts to a label.', configTypeId: 'labels' },
  { key: 'teams', title: 'Teams', description: 'Fleet teams used to segment hosts and scope access (Fleet Premium).', configTypeId: 'teams' },
  { key: 'agent-config', title: 'Agent Configuration', description: 'The org-wide osquery agent options applied to every enrolled host.', configTypeId: 'agent-config' },
]

// The two Fleet stack topologies.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (eval / standalone)' },
  { value: 'distributed', label: 'Distributed stack' },
]

// Fleet's own node tiers — replaces the SDK's former Splunk-only indexer/
// search-head labels. The server maps these onto the same two legacy fields
// (see lib/byolTopology.ts / lib/byolInput.ts): database -> indexerCount
// (MySQL/MariaDB), server -> searchHeadCount (fleet-server).
const TOPOLOGY: ByolTopology = {
  productName: 'Fleet',
  tiers: [
    { key: 'database', label: 'Database nodes', min: 1, help: 'MySQL/MariaDB data tier.' },
    { key: 'server', label: 'Fleet servers', min: 2, help: 'Fleet application/API tier (behind the load balancer).' },
  ],
  infoTooltip:
    'Provision and manage a dedicated Fleet stack (bring-your-own-license): define the topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
}

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/fleet/byol"
      title="BYOL Fleet Stack"
      configBase="/apps/fleet/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={TOPOLOGY}
    />
  )
}
