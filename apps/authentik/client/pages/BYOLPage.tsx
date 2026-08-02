import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * authentik — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The authentik-specific configuration links and stack
 * topology are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's two scalable node tiers — Server
 * nodes (the web/API process, the ALB target) and Worker nodes (background
 * tasks). Both run the SAME container image; only the startup command differs
 * (`server` vs `worker` — see lib/byolTopology.ts). The fixed supporting
 * service (PostgreSQL) is not user-scaled — the server adds it to the resource
 * plan automatically. There is deliberately NO Redis tier: authentik removed
 * Redis entirely in its 2025.10 release (see lib/byolTopology.ts for the cited
 * release note).
 *
 * authentik is open source, so there is NO version picker — `versionOptions`
 * is omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'applications', title: 'Applications', description: 'authentik Applications — slug, provider binding, policy engine mode and metadata.', configTypeId: 'applications' },
  { key: 'oauth2-providers', title: 'OAuth2/OpenID Providers', description: 'OAuth2/OpenID providers — flows, client type/id, redirect URIs and scope mappings.', configTypeId: 'oauth2-providers' },
  { key: 'groups', title: 'Groups', description: 'authentik Groups — superuser flag, parent group and custom attributes.', configTypeId: 'groups' },
  { key: 'flows', title: 'Flows', description: 'authentik Flows — title, designation and required authentication level.', configTypeId: 'flows' },
]

// The two authentik stack deployment types. Node counts for the scalable tiers
// are driven by the `topology` prop below; the server maps them onto the
// authentik stack and adds the fixed supporting service — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (server + worker + PostgreSQL)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/authentik/byol"
      title="BYOL authentik Stack"
      configBase="/apps/authentik/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'authentik',
        tiers: [
          { key: 'server', label: 'Server nodes', min: 1, help: 'authentik server — web/API (the ALB target)' },
          { key: 'worker', label: 'Worker nodes', min: 1, help: 'authentik worker — background tasks (same image, started with the worker command)' },
        ],
        infoTooltip:
          'Provision and manage a dedicated authentik identity provider (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
