import React from 'react'
import { ByolInfrastructureManager, type ByolConfigLink } from '@veltrixsecops/app-sdk/byol'

/**
 * Greenbone — BYOL stack infrastructure management.
 *
 * A thin wrapper over the shared SDK `<ByolInfrastructureManager>`, pointed at
 * this app's app-owned `/byol` routes. All the list/detail/lifecycle UI (the
 * deployment console — resource plan, activity timeline, expandable sidebar)
 * lives in the SDK so any app can reuse it; the data stays app-owned in this
 * app's DB + server. The Greenbone-specific configuration links and stack
 * topology are supplied here, keeping the SDK app-agnostic.
 *
 * The `topology` prop declares this app's two scalable node tiers — Manager
 * nodes (gvmd + GSA web) and Scanner nodes (openvas-scanner). The fixed
 * supporting services (PostgreSQL, Redis) are not user-scaled — the server adds
 * them to the resource plan automatically (see lib/byolTopology.ts).
 *
 * Greenbone / OpenVAS is open source, so there is NO version picker —
 * `versionOptions` is omitted (the SDK form hides the picker for an empty list)
 * and the server carries no version catalog.
 */
const CONFIG_LINKS: ByolConfigLink[] = [
  { key: 'targets', title: 'Scan Targets', description: 'Greenbone scan targets — hosts, exclude hosts and port list.', configTypeId: 'targets' },
  { key: 'port-lists', title: 'Port Lists', description: 'Greenbone port lists — named TCP/UDP port ranges.', configTypeId: 'port-lists' },
  { key: 'schedules', title: 'Schedules', description: 'Greenbone scan schedules — iCalendar (RFC 5545) recurrence + timezone.', configTypeId: 'schedules' },
  { key: 'scan-tasks', title: 'Scan Tasks', description: 'Greenbone scan tasks — target + scan config + scanner with an optional schedule.', configTypeId: 'scan-tasks' },
]

// The two Greenbone stack deployment types. Node counts for the scalable tiers
// are driven by the `topology` prop below; the server maps them onto the
// Greenbone stack and adds the fixed supporting services — see lib/byolTopology.ts.
const DEPLOYMENT_TYPES = [
  { value: 'single', label: 'Single node (all-in-one)' },
  { value: 'distributed', label: 'Distributed stack (manager + scanners + PostgreSQL + Redis)' },
]

export default function BYOLPage() {
  return (
    <ByolInfrastructureManager
      apiBase="/api/apps/greenbone/byol"
      title="BYOL Greenbone Stack"
      configBase="/apps/greenbone/config"
      configLinks={CONFIG_LINKS}
      deploymentTypes={DEPLOYMENT_TYPES}
      topology={{
        productName: 'Greenbone',
        tiers: [
          { key: 'manager', label: 'Manager nodes', min: 1 },
          { key: 'scanner', label: 'Scanner nodes', min: 1 },
        ],
        infoTooltip:
          'Provision and manage a dedicated Greenbone/OpenVAS scanner (bring-your-own-license): define topology, deploy to a Veltrix-hosted or your own cloud account, then manage its lifecycle here.',
      }}
    />
  )
}
