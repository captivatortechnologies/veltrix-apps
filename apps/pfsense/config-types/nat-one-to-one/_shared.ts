// =============================================================================
// Shared helpers for the NAT 1:1 Mappings config type (validate + deploy +
// rollback + drift). Field shapes verified against
// RESTAPI/Models/OneToOneNATMapping.inc — a compact model, no scope cuts
// needed. See lib/pfsenseApi.ts's module doc for the apply-endpoint and
// identity citations.
//
// IDENTITY: like firewall-rules/nat-port-forwards, OneToOneNATMapping
// declares no unique/name field (verified) — this config type tracks
// identity by the CANVAS ITEM's own stable id, recorded in rollbackData
// across deploys.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { OneToOneNatMapping } from '../../lib/pfsenseApi'

export const MAX_DESCRIPTION_LENGTH = 1024

export type IpProtocol = 'inet' | 'inet6'
export const IP_PROTOCOLS: IpProtocol[] = ['inet', 'inet6']

export type NatReflection = 'enable' | 'disable' | ''
export const NAT_REFLECTIONS: NatReflection[] = ['', 'enable', 'disable']

export interface OneToOneSpec {
  itemId: string
  interface: string
  disabled: boolean
  nobinat: boolean
  natreflection: NatReflection
  ipprotocol: IpProtocol
  external: string
  source: string
  destination: string
  descr: string
}

export function specFromItem(item: CanvasItemSnapshot): OneToOneSpec {
  const f = item.fields ?? {}
  const rawIpprotocol = String(f.ipprotocol ?? 'inet').trim()
  const rawNatReflection = String(f.natreflection ?? '').trim()
  return {
    itemId: item.id ?? item.name,
    interface: String(f.interface ?? '').trim(),
    disabled: f.disabled === true,
    nobinat: f.nobinat === true,
    natreflection: (NAT_REFLECTIONS as string[]).includes(rawNatReflection) ? (rawNatReflection as NatReflection) : '',
    ipprotocol: (IP_PROTOCOLS as string[]).includes(rawIpprotocol) ? (rawIpprotocol as IpProtocol) : 'inet',
    external: String(f.external ?? '').trim(),
    source: String(f.source ?? '').trim(),
    destination: String(f.destination ?? '').trim(),
    descr: String(f.descr ?? '').trim(),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): OneToOneSpec[] {
  return items.map(specFromItem)
}

export function toOneToOneBody(spec: OneToOneSpec): Omit<OneToOneNatMapping, 'id'> {
  return {
    interface: spec.interface,
    disabled: spec.disabled,
    nobinat: spec.nobinat,
    natreflection: spec.natreflection || null,
    ipprotocol: spec.ipprotocol,
    external: spec.external,
    source: spec.source,
    destination: spec.destination,
    descr: spec.descr,
  }
}

export function snapshotOneToOne(live: OneToOneNatMapping): Omit<OneToOneNatMapping, 'id'> {
  return {
    interface: live.interface,
    disabled: live.disabled ?? false,
    nobinat: live.nobinat ?? false,
    natreflection: live.natreflection ?? null,
    ipprotocol: live.ipprotocol ?? 'inet',
    external: live.external,
    source: live.source,
    destination: live.destination,
    descr: live.descr ?? '',
  }
}
