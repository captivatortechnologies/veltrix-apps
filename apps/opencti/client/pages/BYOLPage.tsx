import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * OpenCTI — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The OpenCTI-specific configuration links and stack topology
 * are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's three scalable node tiers — Platform
 * nodes (OpenCTI GraphQL/web), Ingest workers, and Search nodes
 * (Elasticsearch / OpenSearch). The fixed supporting services (Redis, RabbitMQ,
 * MinIO/S3 object storage) are not user-scaled — the server adds them to the
 * resource plan automatically (see lib/byolTopology.ts). A distributed search
 * tier runs ≥3 nodes for a real cluster (enforced server-side).
 *
 * OpenCTI is open source, so there is NO version picker — `versionOptions` is
 * omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'marking-definitions', title: 'Marking Definitions', description: 'OpenCTI data-marking definitions — type, definition, color and order.', configTypeId: 'marking-definitions' },
  { key: 'labels', title: 'Labels', description: 'OpenCTI labels — value and color.', configTypeId: 'labels' },
  { key: 'groups', title: 'Groups', description: 'OpenCTI RBAC groups — name, description and assignment defaults.', configTypeId: 'groups' },
  { key: 'ingestion-feeds', title: 'Ingestion Feeds (TAXII2)', description: 'OpenCTI TAXII2 ingestion feeds — endpoint, collection, version and authentication.', configTypeId: 'ingestion-feeds' },
]

// The two OpenCTI stack deployment types. Node counts for the scalable tiers are
// driven by the `topology` prop below; the server maps them onto the OpenCTI
// stack and adds the fixed supporting services — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (platform + workers + Elasticsearch + Redis + RabbitMQ + MinIO)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/opencti/byol"
      title="BYOL OpenCTI Stack"
      configBase="/apps/opencti/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'OpenCTI',
        tiers: [
          { key: 'platform', label: 'Platform nodes', min: 1 },
          { key: 'worker', label: 'Ingest workers', min: 1 },
          { key: 'search', label: 'Search nodes (Elasticsearch)', min: 3 },
        ],
        infoTooltip:
          'Provision and manage a dedicated OpenCTI stack (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
