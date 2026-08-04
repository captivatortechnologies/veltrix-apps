// Shared helpers for the JumpCloud IP Lists config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// IP Lists are applied over the JumpCloud API v2 (/iplists).
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   IPListRequest / IPList: { name, description, ips: string[] }

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** A basic IPv4/IPv6 address or CIDR range matcher — permissive on purpose (JumpCloud
 *  validates the authoritative shape server-side); this only catches obvious typos. */
const IP_OR_CIDR_RE = /^([0-9a-fA-F:.]+)(\/\d{1,3})?$/

/** One JumpCloud IP List as returned by GET /iplists and GET /iplists/{id}. */
export interface JumpCloudIpList {
  id?: string
  name?: string
  description?: string
  ips?: string[]
  [key: string]: unknown
}

/** The desired state for one IP List, extracted from a canvas item. */
export interface IpListSpec {
  /** Stable canvas item id — survives renames; used for rename-safe identity. */
  itemId?: string
  /** IP List name — the logical identity live lists are matched on. */
  name: string
  description: string
  ips: string[]
}

/** Split an `ips` value (a tags array or a newline/comma string) into trimmed entries. */
export function toIpList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    const s = String(entry ?? '').trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Whether an entry looks like a plausible IP address or CIDR range. */
export function isPlausibleIpOrCidr(value: string): boolean {
  return IP_OR_CIDR_RE.test(value.trim())
}

/** Each canvas item describes one JumpCloud IP List. */
export function extractIpListSpecs(canvas: CanvasSnapshot): IpListSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      name: String(fields.name ?? '').trim(),
      description: String(fields.description ?? '').trim(),
      ips: toIpList(fields.ips),
    }
  })
}

/** Find a live IP List by name (case-insensitive — the stable identity). */
export function findIpListByName(lists: JumpCloudIpList[], name: string): JumpCloudIpList | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return lists.find((l) => String(l.name ?? '').trim().toLowerCase() === target) ?? null
}

/**
 * Build the JumpCloud IP List body for POST/PUT /iplists. `ips` is always sent as
 * the complete list — a PUT replaces the live list wholesale, so the canvas item
 * fully owns membership (no additive/exclusive distinction needed).
 */
export function buildIpListBody(spec: IpListSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description, ips: spec.ips }
}

/** The subset of a live list's fields this config type manages — captured for rollback. */
export function priorFieldsOf(list: JumpCloudIpList): Record<string, unknown> {
  return {
    name: String(list.name ?? ''),
    description: String(list.description ?? ''),
    ips: Array.isArray(list.ips) ? list.ips : [],
  }
}
