import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Velociraptor — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Velociraptor-specific configuration links and stack
 * topology options are supplied here, keeping the SDK app-agnostic.
 *
 * Velociraptor is open source, so there is NO version picker — `versionOptions`
 * is omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'custom-artifacts', title: 'Custom Artifacts', description: 'Velociraptor custom VQL artifacts — name, type and the artifact YAML/VQL.', configTypeId: 'custom-artifacts' },
  { key: 'client-monitoring', title: 'Client Monitoring', description: 'Client event-collection rules per client label group.', configTypeId: 'client-monitoring' },
  { key: 'server-monitoring', title: 'Server Monitoring', description: 'The server-wide SERVER_EVENT artifact list (singleton).', configTypeId: 'server-monitoring' },
  { key: 'users-acls', title: 'Users & ACLs', description: 'Velociraptor GUI users and their roles.', configTypeId: 'users-acls' },
]

// The two Velociraptor stack topologies. Node counts for each are driven by the
// `topology` prop below (Frontend nodes / Datastore nodes); the server maps them
// onto the Velociraptor stack — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (frontends + shared MinIO datastore)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/velociraptor/byol"
      title="BYOL Velociraptor Stack"
      configBase="/apps/velociraptor/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Velociraptor',
        tiers: [
          { key: 'frontend', label: 'Frontend nodes', min: 1, help: 'Velociraptor server (GUI + frontend + gRPC API), behind the load balancer.' },
          { key: 'datastore', label: 'Datastore nodes (MinIO)', min: 1, help: 'Shared S3/MinIO file + datastore backend.' },
        ],
        infoTooltip:
          'Provision and manage a dedicated Velociraptor server (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
