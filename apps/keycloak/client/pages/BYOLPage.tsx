import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Keycloak — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Keycloak-specific configuration links and stack topology
 * are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's single scalable node tier — Keycloak
 * nodes (the Infinispan-clustered IAM servers, ALB targets). The fixed supporting
 * PostgreSQL datastore is not user-scaled — the server adds it to the resource
 * plan automatically (see lib/byolTopology.ts).
 *
 * Keycloak is open source, so there is NO version picker — `versionOptions` is
 * omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'clients', title: 'Clients', description: 'Keycloak OIDC/SAML clients — clientId, name, protocol, flows and redirect URIs.', configTypeId: 'clients' },
  { key: 'realm-roles', title: 'Realm Roles', description: 'Keycloak realm roles — name, description and composite flag.', configTypeId: 'realm-roles' },
  { key: 'groups', title: 'Groups', description: 'Keycloak top-level realm groups — attributes and assigned realm roles.', configTypeId: 'groups' },
  { key: 'identity-providers', title: 'Identity Providers', description: 'Keycloak identity provider instances — alias, type, enabled state and provider config.', configTypeId: 'identity-providers' },
]

// The two Keycloak stack deployment types. Node counts for the scalable tier are
// driven by the `topology` prop below; the server maps them onto the Keycloak
// stack and adds the fixed PostgreSQL datastore — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (clustered Keycloak + PostgreSQL)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/keycloak/byol"
      title="BYOL Keycloak Stack"
      configBase="/apps/keycloak/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Keycloak',
        tiers: [{ key: 'server', label: 'Keycloak nodes', min: 1 }],
        infoTooltip:
          'Provision and manage a dedicated Keycloak cluster (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
