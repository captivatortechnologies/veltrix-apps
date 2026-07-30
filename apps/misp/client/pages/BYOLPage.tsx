import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * MISP — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The MISP-specific configuration links and stack topology
 * options are supplied here, keeping the SDK app-agnostic.
 *
 * MISP is open source, so there is NO version picker — `versionOptions` is
 * omitted (the SDK form hides the picker for an empty list) and the server
 * carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'feeds', title: 'Threat Feeds', description: 'MISP threat feeds — provider, feed URL, source format and enabled state.', configTypeId: 'feeds' },
  { key: 'taxonomies', title: 'Taxonomies', description: 'Enable or disable MISP taxonomies by namespace (e.g. tlp).', configTypeId: 'taxonomies' },
  { key: 'warninglists', title: 'Warninglists', description: 'Enable or disable MISP warninglists by name.', configTypeId: 'warninglists' },
  { key: 'sharing-groups', title: 'Sharing Groups', description: 'MISP sharing groups — name, description and releasability.', configTypeId: 'sharing-groups' },
  { key: 'organisations', title: 'Organisations', description: 'MISP organisations — name, description, nationality and local flag.', configTypeId: 'organisations' },
  { key: 'sync-servers', title: 'Sync Servers', description: 'MISP sync servers — remote URL, authkey and pull/push flags.', configTypeId: 'sync-servers' },
]

// The two MISP stack topologies. The SDK form reuses its Splunk-shaped node knobs
// (Indexers / Search heads); the server maps them to the MISP stack (MariaDB
// database nodes / MISP core nodes — see lib/byolTopology.ts).
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (core + MariaDB + Redis)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/misp/byol"
      title="BYOL MISP Stack"
      configBase="/apps/misp/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
    />
  )
}
