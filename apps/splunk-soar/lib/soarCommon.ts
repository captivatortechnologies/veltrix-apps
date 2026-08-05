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
