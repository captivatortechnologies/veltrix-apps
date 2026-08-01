// Shared helpers for the Cisco Umbrella Sites config type
// (validate + deploy + rollback + drift).
//
// An Umbrella Site (/deployments/v2/sites) is a physical location grouping for
// deployed Umbrella Virtual Appliances. Sites are addressed by an opaque
// `siteId` (no lookup-by-name), so a declared site is matched to a live one by
// NAME and the siteId is stored after deploy for rename-safety. The default site
// (isDefault) is never deleted by reconcile/rollback. Shapes follow the Umbrella
// Deployments API; verify against a live Umbrella tenant.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import {
  DEPLOYMENTS_SITES_PATH,
  type DeployableResource,
  type LiveResource,
} from '../../lib/deployments'

export const MAX_NAME_LENGTH = 50

/** One site declared on the canvas (one item). */
export interface SiteSpec {
  itemId?: string
  /** name — the logical identity (Umbrella sites are siteId-addressed). */
  name: string
}

/** A site as returned by GET /deployments/v2/sites. */
export interface LiveSite extends LiveResource {
  siteId?: number | string
  originId?: number | string
  id?: number | string
  name?: string
  isDefault?: boolean
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBoolean(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === 1 || v === '1'
}

export function extractSiteSpecs(canvas: CanvasSnapshot): SiteSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => ({
    itemId: item.id,
    name: asString(item.fields?.name) || item.name,
  }))
}

function liveId(live: LiveResource): string | number | undefined {
  const l = live as LiveSite
  return l.siteId ?? l.originId ?? l.id
}

/** Descriptor driving the generic deploy/rollback/drift engine for sites. */
export const SITE_RESOURCE: DeployableResource<SiteSpec> = {
  label: 'site',
  labelPlural: 'sites',
  collectionPath: DEPLOYMENTS_SITES_PATH,
  resourcePath: (id) => `${DEPLOYMENTS_SITES_PATH}/${encodeURIComponent(String(id))}`,
  keyOfSpec: (spec) => spec.name.toLowerCase(),
  keyOfLive: (live) => asString((live as LiveSite).name).toLowerCase(),
  nameOfSpec: (spec) => spec.name,
  idOfLive: liveId,
  body: (spec) => ({ name: spec.name }),
  bodyFromLive: (live) => ({ name: asString((live as LiveSite).name) }),
  // Never delete the Umbrella default site.
  deletable: (live) => !asBoolean((live as LiveSite).isDefault),
}
