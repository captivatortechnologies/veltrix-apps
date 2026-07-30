import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Fleet — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Fleet-specific configuration links and stack topology
 * options are supplied here, keeping the SDK app-agnostic.
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

// The two Fleet stack topologies. The SDK form reuses its Splunk-shaped node
// knobs (Indexers / Search heads / Heavy forwarders); the server maps them to the
// Fleet stack (MySQL databases / Fleet servers / Redis — see lib/byolTopology.ts).
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (eval / standalone)' },
  { value: 'distributed', label: 'Distributed stack' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/fleet/byol"
      title="BYOL Fleet Stack"
      configBase="/apps/fleet/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
    />
  )
}
