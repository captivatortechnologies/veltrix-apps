// =============================================================================
// Shared helpers for the Gateways config type (validate + deploy + rollback
// + drift). Field shapes verified against RESTAPI/Models/RoutingGateway.inc
// — see lib/pfsenseApi.ts's module doc for the scoped-field-set and
// routing-apply-endpoint citations.
//
// IDENTITY: `name` (StringField unique:true, editable:false) — natural key,
// immutable once created, same pattern as firewall-aliases.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { RoutingGateway } from '../../lib/pfsenseApi'

export const MAX_NAME_LENGTH = 31
export const MAX_DESCRIPTION_LENGTH = 1024

export type IpProtocol = 'inet' | 'inet6'
export const IP_PROTOCOLS: IpProtocol[] = ['inet', 'inet6']

export interface GatewaySpec {
  itemId?: string
  name: string
  descr: string
  disabled: boolean
  ipprotocol: IpProtocol | ''
  interface: string
  gateway: string
  monitorDisable: boolean
  monitor: string
  weight: number
}

/**
 * Passed through as-is (not clamped) so validate.ts can flag an
 * out-of-range value as an error instead of it being silently coerced —
 * only a genuinely non-numeric value falls back to the field's own default (1).
 */
function parseWeight(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 1
}

export function specFromItem(item: CanvasItemSnapshot): GatewaySpec {
  const f = item.fields ?? {}
  const rawIpprotocol = String(f.ipprotocol ?? 'inet').trim()
  return {
    itemId: item.id,
    name: String(f.name ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
    disabled: f.disabled === true,
    ipprotocol: (IP_PROTOCOLS as string[]).includes(rawIpprotocol) ? (rawIpprotocol as IpProtocol) : '',
    interface: String(f.interface ?? '').trim(),
    gateway: String(f.gateway ?? '').trim(),
    monitorDisable: f.monitor_disable === true,
    monitor: String(f.monitor ?? '').trim(),
    weight: parseWeight(f.weight ?? 1),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): GatewaySpec[] {
  return items.map(specFromItem)
}

/** Gateway-name identity — exact match, case-sensitive (matches FilterNameValidator's charset, which is case-preserving). */
export function gatewayKey(name: string): string {
  return name.trim()
}

/** The full create-request body for a spec (POST). */
export function toGatewayCreateBody(spec: GatewaySpec): Omit<RoutingGateway, 'id'> {
  return {
    name: spec.name,
    descr: spec.descr,
    disabled: spec.disabled,
    ipprotocol: spec.ipprotocol as IpProtocol,
    interface: spec.interface,
    gateway: spec.gateway,
    monitor_disable: spec.monitorDisable,
    monitor: spec.monitorDisable ? null : spec.monitor || null,
    weight: spec.weight,
  }
}

/** The PATCH request body for a spec — `name` is OMITTED (immutable, see FirewallAlias-style doc above). */
export function toGatewayUpdateBody(spec: GatewaySpec): Omit<RoutingGateway, 'id' | 'name'> {
  const { name: _name, ...rest } = toGatewayCreateBody(spec)
  return rest
}

/** Snapshot a live gateway's managed fields for rollback (never `name`). */
export function snapshotGateway(live: RoutingGateway): Omit<RoutingGateway, 'id' | 'name'> {
  return {
    descr: live.descr ?? '',
    disabled: live.disabled ?? false,
    ipprotocol: live.ipprotocol,
    interface: live.interface,
    gateway: live.gateway,
    monitor_disable: live.monitor_disable ?? false,
    monitor: live.monitor ?? null,
    weight: live.weight ?? 1,
  }
}
