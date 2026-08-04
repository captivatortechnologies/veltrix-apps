// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense
// unbound-domain-overrides config type — mapped onto `dots.dot` with
// `type: "forward"` (see lib/unboundApi.ts's module doc for the full
// terminology citation: the legacy "Domain Override" concept has no separate
// endpoint in the current MVC model). No meaningful OPNsense version floor.
//
// IDENTITY: `domain` (required by THIS app's canvas, though not required by
// the model itself — a blank domain there means "catch-all default forward",
// a use case this app deliberately does not support; see README's Coverage
// section). Deduped case-insensitively per canvas.
//
// Dropped for v0.3.0, flagged rather than faked: `verify` (the TLS server
// name to check for DNS-over-TLS entries — irrelevant here since this config
// type only ever creates plain "forward" entries, never "dot" ones).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { DomainOverrideBody, LiveDomainOverride } from '../../lib/unboundApi'

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

export interface DomainOverrideSpec {
  itemId?: string
  domain: string
  enabled: boolean
  server: string
  port: number | null
  forwardTcpUpstream: boolean
  forwardFirst: boolean
  description: string
}

export function domainOverrideKey(domain: string): string {
  return domain.trim().toLowerCase()
}

export function extractDomainOverrideSpecs(canvas: CanvasSnapshot): DomainOverrideSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      domain: asStringOrItemName(f.domain, item.name),
      enabled: asBool(f.enabled, true),
      server: asString(f.server),
      port: typeof f.port === 'number' && Number.isFinite(f.port) ? f.port : null,
      forwardTcpUpstream: asBool(f.forward_tcp_upstream, false),
      forwardFirst: asBool(f.forward_first, false),
      description: asString(f.description),
    }
  })
}

export function buildDomainOverrideBody(spec: DomainOverrideSpec): DomainOverrideBody {
  return {
    enabled: spec.enabled ? '1' : '0',
    domain: spec.domain,
    server: spec.server,
    port: spec.port != null ? String(spec.port) : '',
    forward_tcp_upstream: spec.forwardTcpUpstream ? '1' : '0',
    forward_first: spec.forwardFirst ? '1' : '0',
    description: spec.description,
  }
}

export function snapshotLive(live: LiveDomainOverride): DomainOverrideBody {
  return {
    enabled: String(live.enabled ?? '1'),
    domain: String(live.domain ?? ''),
    server: String(live.server ?? ''),
    port: String(live.port ?? ''),
    forward_tcp_upstream: String(live.forward_tcp_upstream ?? '0'),
    forward_first: String(live.forward_first ?? '0'),
    description: String(live.description ?? ''),
  }
}
