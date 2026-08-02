// Shared helpers for the Greenbone Port Lists config type (deploy + rollback +
// drift). A port list is a named set of TCP/UDP port ranges a scan target scans.
// Applied over GMP (XML over TLS). The port-list NAME is the stable identity used
// to upsert — gvmd does not enforce unique names, so this app treats the name as
// the key.
//
// FLAG (GMP 22.5): modify_port_list only changes name/comment — the port ranges
// are immutable via modify (you would create_port_range/delete_port_range or
// recreate the list). Deploy surfaces a changed range rather than silently
// dropping it; drift flags it too. The canvas port_range string ("T:1-1024,U:53")
// is normalised to the same canonical form gvmd's structured <port_range> triples
// reconstruct to, so the two compare cleanly.

import type { GmpPortList } from '../../lib/greenboneApi'

const PORT_TOKEN_RE = /^([TUtu])\s*:\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/
const MAX_PORT = 65535

export interface PortRangeToken {
  type: 'T' | 'U'
  start: number
  end: number
}

/**
 * Parse a compact port-range string ("T:1-1024, U:53, T:3389") into tokens,
 * collecting any tokens that are malformed or out of range so validate.ts can
 * report them precisely.
 */
export function parsePortRange(value: unknown): { tokens: PortRangeToken[]; invalid: string[] } {
  const tokens: PortRangeToken[] = []
  const invalid: string[] = []
  for (const raw of String(value ?? '').split(',')) {
    const tok = raw.trim()
    if (!tok) continue
    const m = PORT_TOKEN_RE.exec(tok)
    if (!m) {
      invalid.push(tok)
      continue
    }
    const type: 'T' | 'U' = m[1].toUpperCase() === 'U' ? 'U' : 'T'
    const start = Number(m[2])
    const end = m[3] !== undefined ? Number(m[3]) : start
    if (start < 1 || start > MAX_PORT || end < 1 || end > MAX_PORT || start > end) {
      invalid.push(tok)
      continue
    }
    tokens.push({ type, start, end })
  }
  return { tokens, invalid }
}

/**
 * Canonical form of a port-range string: each token as "T:start" or "T:start-end"
 * (TCP→T, UDP→U), sorted and comma-joined. Matches lib/greenboneApi's
 * portRangesToCompact() so a declared range compares equal to the live one gvmd
 * reconstructs from its structured <port_range> triples.
 */
export function canonicalPortRange(value: unknown): string {
  const { tokens } = parsePortRange(value)
  return tokens
    .map((t) => (t.end !== t.start ? `${t.type}:${t.start}-${t.end}` : `${t.type}:${t.start}`))
    .sort()
    .join(',')
}

export interface PortListItem {
  name: string
  /** Canonical port-range string sent to gvmd on create. */
  portRange: string
  comment?: string
}

/** Build the port-list input from a canvas item's fields (canonicalising the range). */
export function buildPortListInput(fields: Record<string, unknown>): PortListItem {
  return {
    name: String(fields.name ?? '').trim(),
    portRange: canonicalPortRange(fields.portRange),
    comment: String(fields.comment ?? '').trim(),
  }
}

/** Find a live port list by name (trimmed, case-sensitive). */
export function findPortListByName(portLists: GmpPortList[], name: string): GmpPortList | null {
  const n = name.trim()
  if (!n) return null
  return portLists.find((p) => p.name.trim() === n) ?? null
}
