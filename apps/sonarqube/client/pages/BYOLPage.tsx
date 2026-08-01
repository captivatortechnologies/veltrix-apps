import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * SonarQube — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The SonarQube-specific configuration links and stack
 * topology are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's two scalable node tiers — Application
 * nodes (SonarQube web + compute engine) and Search nodes (Elasticsearch). The
 * fixed PostgreSQL database is not user-scaled — the server adds it to the
 * resource plan automatically (see lib/byolTopology.ts). A distributed search
 * tier runs ≥3 nodes for a real cluster (enforced server-side).
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'quality-gates', title: 'Quality Gates', description: 'SonarQube quality gates — name, default flag and pass/fail conditions.', configTypeId: 'quality-gates' },
  { key: 'quality-profiles', title: 'Quality Profiles', description: 'SonarQube quality profiles — language, inheritance, default flag and activated rules.', configTypeId: 'quality-profiles' },
  { key: 'webhooks', title: 'Webhooks', description: 'SonarQube global and project webhooks — delivery URL and optional HMAC secret.', configTypeId: 'webhooks' },
  { key: 'permission-templates', title: 'Permission Templates', description: 'SonarQube permission templates — project-key pattern and group grants.', configTypeId: 'permission-templates' },
]

// The two SonarQube stack deployment types. Node counts for the scalable tiers
// are driven by the `topology` prop below; the server maps them onto the
// SonarQube stack and adds the fixed PostgreSQL — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one + PostgreSQL)' },
  { value: 'distributed', label: 'Distributed stack (Data Center Edition — app nodes + Elasticsearch search + PostgreSQL)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/sonarqube/byol"
      title="BYOL SonarQube Stack"
      configBase="/apps/sonarqube/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'SonarQube',
        tiers: [
          { key: 'application', label: 'Application nodes', min: 1 },
          { key: 'search', label: 'Search nodes (Elasticsearch)', min: 1 },
        ],
        infoTooltip:
          'Provision and manage a dedicated SonarQube stack (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
