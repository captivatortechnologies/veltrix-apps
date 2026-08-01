import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * TheHive — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The TheHive-specific configuration links and stack topology
 * are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's three scalable node tiers — Application
 * nodes (TheHive web/API), Cassandra nodes (the primary data store), and
 * Elasticsearch nodes (the search index). The fixed supporting service (MinIO/S3
 * object storage for file attachments) is not user-scaled — the server adds it to
 * the resource plan automatically (see lib/byolTopology.ts). A distributed
 * Cassandra ring and Elasticsearch cluster each run ≥3 nodes for a real HA
 * quorum (enforced server-side).
 *
 * TheHive is open source, so there is NO version picker — `versionOptions` is
 * omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'case-templates', title: 'Case Templates', description: 'TheHive case templates — display name, title prefix, severity, TLP/PAP, tags, description and prefilled tasks.', configTypeId: 'case-templates' },
  { key: 'custom-fields', title: 'Custom Fields', description: 'TheHive custom fields — name, display name, group, data type, mandatory flag and enumeration options.', configTypeId: 'custom-fields' },
  { key: 'observable-types', title: 'Observable Types', description: 'TheHive observable (datatype) types — name and file-attachment flag.', configTypeId: 'observable-types' },
  { key: 'users', title: 'Users', description: 'TheHive users — login, display name, email, profile (role) and organisation.', configTypeId: 'users' },
]

// The two TheHive stack deployment types. Node counts for the scalable tiers are
// driven by the `topology` prop below; the server maps them onto the TheHive
// stack and adds the fixed object store — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (TheHive + Cassandra + Elasticsearch + MinIO)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/thehive/byol"
      title="BYOL TheHive Stack"
      configBase="/apps/thehive/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'TheHive',
        tiers: [
          { key: 'application', label: 'Application nodes', min: 1 },
          { key: 'cassandra', label: 'Cassandra nodes', min: 1 },
          { key: 'index', label: 'Elasticsearch nodes', min: 1 },
        ],
        infoTooltip:
          'Provision and manage a dedicated TheHive stack (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
