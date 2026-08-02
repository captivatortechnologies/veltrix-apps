import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Graylog — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Graylog-specific configuration links and stack topology
 * are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's two scalable node tiers — Graylog nodes
 * (web/REST/API) and OpenSearch nodes (data/search). The fixed supporting service
 * (MongoDB metadata store) is not user-scaled — the server adds it to the resource
 * plan automatically (see lib/byolTopology.ts). A distributed OpenSearch tier runs
 * ≥3 nodes for a real cluster (enforced server-side).
 *
 * Graylog is open source, so there is NO version picker — `versionOptions` is
 * omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'streams', title: 'Streams', description: 'Graylog message streams — title, description, matching type and rules.', configTypeId: 'streams' },
  { key: 'inputs', title: 'Inputs', description: 'Graylog message inputs — title, type, global flag and configuration.', configTypeId: 'inputs' },
  { key: 'pipeline-rules', title: 'Pipeline Rules', description: 'Graylog processing pipeline rules — title, description and rule DSL source.', configTypeId: 'pipeline-rules' },
  { key: 'index-sets', title: 'Index Sets', description: 'Graylog index sets — index prefix, rotation and retention strategy.', configTypeId: 'index-sets' },
]

// The two Graylog stack deployment types. Node counts for the scalable tiers are
// driven by the `topology` prop below; the server maps them onto the Graylog
// stack and adds the fixed MongoDB service — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (Graylog + OpenSearch + MongoDB)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/graylog/byol"
      title="BYOL Graylog Stack"
      configBase="/apps/graylog/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Graylog',
        tiers: [
          { key: 'graylog', label: 'Graylog nodes', min: 1 },
          { key: 'opensearch', label: 'OpenSearch nodes', min: 1 },
        ],
        infoTooltip:
          'Provision and manage a dedicated Graylog stack (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
