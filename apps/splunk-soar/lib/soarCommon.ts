// =============================================================================
// Shared, transport-free helpers for the SOAR config types beyond `connection`.
// Kept separate from lib/soarApi.ts (the REST transport) so comparison/parsing
// logic can be reused without pulling in fetch/network concerns.
// =============================================================================

/** Stable, key-sorted JSON of a value — for order-insensitive drift comparison. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>()
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v as object)) return null
    seen.add(v as object)
    if (Array.isArray(v)) return v.map(sort)
    return Object.keys(v as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sort((v as Record<string, unknown>)[k])
        return acc
      }, {})
  }
  return JSON.stringify(sort(value))
}

/** A subset of `source` limited to `keys` — for comparing only the fields we declare. */
export function pickKeys(source: Record<string, unknown> | null | undefined, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!source) return out
  for (const k of keys) if (k in source) out[k] = source[k]
  return out
}

/** `source` with every key in `keys` removed — for stripping write-only material before persisting a snapshot. */
export function stripKeys<T extends Record<string, unknown>>(source: T, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...source }
  for (const k of keys) delete out[k]
  return out
}

/**
 * Read a list-of-strings field the canvas may hand back as either a real array
 * (a `tags` field) or a comma-separated string — same defensive shape used
 * across the platform for tag-like fields.
 */
export function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean)
  return []
}

/** Normalize a yes/no-ish select (or boolean / 1|0) to a boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'yes' || s === 'true' || s === '1'
}

/** Read a number field that may arrive as a string from the canvas; falls back when blank/invalid. */
export function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value ?? '').trim()
  if (!s) return fallback
  const n = Number(s)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse a simple CSV-shaped textarea into a 2D array of cell strings — one row
 * per line, comma-separated cells, minimal quoting (a cell wrapped in double
 * quotes may contain commas; `""` inside a quoted cell is a literal `"`).
 * Blank lines are skipped. Used for Custom Lists' `content`.
 */
export function parseCsvRows(raw: unknown): string[][] {
  const text = String(raw ?? '')
  const rows: string[][] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const cells: string[] = []
    let cur = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"'
          i++
        } else if (ch === '"') {
          inQuotes = false
        } else {
          cur += ch
        }
      } else if (ch === '"' && cur === '') {
        inQuotes = true
      } else if (ch === ',') {
        cells.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    cells.push(cur.trim())
    rows.push(cells)
  }
  return rows
}

/** Render a 2D array of cells back into the same CSV-shaped textarea format `parseCsvRows` reads. */
export function formatCsvRows(rows: unknown): string {
  if (!Array.isArray(rows)) return ''
  return rows
    .map((row) => (Array.isArray(row) ? row : [row]).map((cell) => formatCsvCell(String(cell ?? ''))).join(','))
    .join('\n')
}

function formatCsvCell(cell: string): string {
  return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
}

// --- Field-format validators ---------------------------------------------------
//
// These exist because several canvas fields PROMISE a format in their helpText
// and nothing enforced it, so a malformed value was only rejected by SOAR at
// DEPLOY time — after the pipeline had started and, for a multi-record canvas,
// possibly after earlier records had already been created.

/** One IPv4 octet: 0-255, no leading zeros. */
const IPV4_OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])'
const IPV4 = new RegExp(`^${IPV4_OCTET}(\\.${IPV4_OCTET}){3}$`)

/**
 * True for a bare IPv4/IPv6 address or a CIDR block.
 *
 * Both are accepted: SOAR's `allowed_ips` takes either, and someone entering a
 * single address should not have to write `/32`. IPv6 is matched loosely — the
 * full grammar with `::` compression is not worth reimplementing here, and
 * accepting an odd-looking but real address costs far less than rejecting a
 * valid one.
 */
export function isIpOrCidr(value: string): boolean {
  const text = value.trim()
  if (!text) return false

  const parts = text.split('/')
  if (parts.length > 2) return false
  const [address, prefix] = parts

  const isV4 = IPV4.test(address)
  const isV6 = address.includes(':') && /^[0-9a-fA-F:]+$/.test(address)
  if (!isV4 && !isV6) return false

  if (prefix === undefined) return true
  if (!/^[0-9]{1,3}$/.test(prefix)) return false
  const bits = Number(prefix)
  return bits >= 0 && bits <= (isV4 ? 32 : 128)
}

/**
 * A deliberately permissive email check: one `@`, something either side, a dot
 * in the domain, no whitespace. A stricter regex rejects addresses that are
 * genuinely valid, which is a worse failure than letting an odd one through —
 * SOAR is the authority on what it accepts.
 */
export function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * True when the runtime recognises this as an IANA time zone.
 *
 * Asks Intl rather than pattern-matching `Area/Location`: that is the
 * authoritative list, and it accepts legitimate names a naive pattern would
 * reject (`UTC`, `Etc/GMT+5`). If the runtime cannot answer — a build without
 * full ICU — the value is accepted, so a constrained environment degrades to
 * the previous behaviour instead of rejecting every zone.
 */
export function isTimeZone(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text })
    return true
  } catch (err) {
    // RangeError means the runtime knows time zones and rejected this one.
    return !(err instanceof RangeError)
  }
}
