// =============================================================================
// Shared helpers for the Static Routes config type (validate + deploy +
// rollback + drift). Field shapes verified against RESTAPI/Models/StaticRoute.inc
// — see lib/pfsenseApi.ts's module doc for the routing-apply-endpoint and
// identity citations.
//
// IDENTITY: like firewall-rules/nat-port-forwards, StaticRoute declares no
// unique/name field (verified) — this config type tracks identity by the
// CANVAS ITEM's own stable id, recorded in rollbackData across deploys.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { StaticRoute } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export interface StaticRouteSpec {
  itemId: string
  network: string
  gateway: string
  descr: string
  disabled: boolean
}

export function specFromItem(item: CanvasItemSnapshot): StaticRouteSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id ?? item.name,
    network: String(f.network ?? '').trim(),
    gateway: String(f.gateway ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    disabled: f.disabled === true,
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): StaticRouteSpec[] {
  return items.map(specFromItem)
}

export function toStaticRouteBody(spec: StaticRouteSpec): Omit<StaticRoute, 'id'> {
  return { network: spec.network, gateway: spec.gateway, descr: spec.descr, disabled: spec.disabled }
}

export function snapshotStaticRoute(live: StaticRoute): Omit<StaticRoute, 'id'> {
  return { network: live.network, gateway: live.gateway, descr: live.descr ?? '', disabled: live.disabled ?? false }
}
