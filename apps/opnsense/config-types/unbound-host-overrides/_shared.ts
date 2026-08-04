// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense
// unbound-host-overrides config type (`/api/unbound/settings/*HostOverride`,
// `/api/unbound/service/reconfigure` — see lib/unboundApi.ts's module doc for
// the full citation trail). No meaningful OPNsense version floor.
//
// IDENTITY: `hosts.host` has no single name field — this app reconciles by
// the (hostname, domain) COMPOSITE pair, which together form the DNS name
// this override answers for. Not enforced unique by the model itself, so
// this app enforces it client-side (case-insensitive), the same spirit as
// firewall-aliases' name dedup.
//
// Dropped for v0.3.0, flagged rather than faked: `aliases` (a computed,
// volatile reflection of the SEPARATE `aliases.alias` CNAME-style resource —
// not settable on a host directly, and that resource isn't built this wave;
// see README's Coverage section).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { HostOverrideBody, LiveHostOverride } from '../../lib/unboundApi'

export const RECORD_TYPES = ['A', 'AAAA', 'MX', 'TXT'] as const

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Trim a string field, defaulting to the canvas item's own `name` ONLY when
 * the raw field value was never provided (undefined/null). An EXPLICIT empty
 * string is preserved as-is, so a required field left genuinely blank is
 * still caught by validate.ts instead of being silently masked by the
 * item's unrelated `name` metadata.
 */
function asStringOrItemName(value: unknown, itemName: string): string {
  if (value === undefined || value === null) return itemName
  return asString(value)
}

export interface HostOverrideSpec {
  itemId?: string
  hostname: string
  domain: string
  enabled: boolean
  rr: string // "A" | "AAAA" | "MX" | "TXT"
  server: string // required when rr = A/AAAA
  mxprio: number | null // required when rr = MX
  mx: string // required when rr = MX
  txtdata: string // required when rr = TXT
  ttl: number | null
  addPtr: boolean
  description: string
}

/** The composite (hostname, domain) identity — case-insensitive, matching a DNS name's own case-insensitivity. */
export function hostOverrideKey(hostname: string, domain: string): string {
  return `${hostname.trim().toLowerCase()}.${domain.trim().toLowerCase()}`
}

export function extractHostOverrideSpecs(canvas: CanvasSnapshot): HostOverrideSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      hostname: asStringOrItemName(f.hostname, item.name),
      domain: asString(f.domain),
      enabled: asBool(f.enabled, true),
      rr: asString(f.rr) || 'A',
      server: asString(f.server),
      mxprio: typeof f.mxprio === 'number' && Number.isFinite(f.mxprio) ? f.mxprio : null,
      mx: asString(f.mx),
      txtdata: asString(f.txtdata),
      ttl: typeof f.ttl === 'number' && Number.isFinite(f.ttl) ? f.ttl : null,
      addPtr: asBool(f.addptr, true),
      description: asString(f.description),
    }
  })
}

export function buildHostOverrideBody(spec: HostOverrideSpec): HostOverrideBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    hostname: spec.hostname,
    domain: spec.domain,
    rr: spec.rr,
    mxprio: spec.mxprio != null ? String(spec.mxprio) : '',
    mx: spec.mx,
    ttl: spec.ttl != null ? String(spec.ttl) : '',
    server: spec.server,
    txtdata: spec.txtdata,
    addptr: spec.addPtr ? '1' : '0',
    description: spec.description,
  }
}

export function snapshotLive(live: LiveHostOverride): HostOverrideBody {
  return {
    enabled: String(live.enabled ?? '1'),
    hostname: String(live.hostname ?? ''),
    domain: String(live.domain ?? ''),
    rr: String(live.rr ?? 'A'),
    mxprio: String(live.mxprio ?? ''),
    mx: String(live.mx ?? ''),
    ttl: String(live.ttl ?? ''),
    server: String(live.server ?? ''),
    txtdata: String(live.txtdata ?? ''),
    addptr: String(live.addptr ?? '1'),
    description: String(live.description ?? ''),
  }
}

export function isValidRecordType(value: string): boolean {
  return (RECORD_TYPES as readonly string[]).includes(value)
}
