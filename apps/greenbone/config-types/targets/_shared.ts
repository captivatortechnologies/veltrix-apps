// Shared helpers for the Greenbone Scan Targets config type (deploy + rollback +
// drift). A "target" is a named set of hosts (CIDRs / IPs / hostnames) plus the
// port list to scan. Applied over GMP (XML over TLS). The target NAME is the
// stable identity used to upsert — gvmd does not enforce unique names, so this
// app treats the name as the key (last one wins on a duplicate).

import { PORT_LIST_ALL_IANA_TCP, type GmpTarget, type TargetInput } from '../../lib/greenboneApi'

export { PORT_LIST_ALL_IANA_TCP }

/** A UUID-shaped port list id (8-4-4-4-12 hex). */
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Split a hosts string (comma / whitespace / newline separated) into tokens. */
export function splitHosts(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean)
}

/**
 * Canonicalise a hosts string for comparison: dedupe + sort the tokens so
 * "10.0.0.1, 10.0.0.2" and "10.0.0.2 10.0.0.1" compare equal.
 */
export function normalizeHosts(value: unknown): string {
  return Array.from(new Set(splitHosts(value))).sort().join(', ')
}

/** Build the GMP target input from a canvas item's fields. */
export function buildTargetInput(fields: Record<string, unknown>): TargetInput {
  const hosts = splitHosts(fields.hosts).join(', ')
  const portListId = String(fields.portListId ?? '').trim() || PORT_LIST_ALL_IANA_TCP
  return {
    name: String(fields.name ?? '').trim(),
    hosts,
    portListId,
    comment: String(fields.comment ?? '').trim(),
    excludeHosts: String(fields.excludeHosts ?? '').trim(),
  }
}

/** Find a live target by name (trimmed, case-sensitive — GMP names are case-sensitive). */
export function findTargetByName(targets: GmpTarget[], name: string): GmpTarget | null {
  const n = name.trim()
  if (!n) return null
  return targets.find((t) => t.name.trim() === n) ?? null
}
