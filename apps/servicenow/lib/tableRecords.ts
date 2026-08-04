// =============================================================================
// Generic ServiceNow Table-record helpers shared by the config types that
// upsert a single sys_* table by a natural key (query-then-PATCH/POST).
//
// These are deliberately table-agnostic — each config type supplies its own
// column mapping in its _shared.ts spec and reuses these normalizers so the
// coercion rules (ServiceNow booleans, integers, encoded queries) live in one
// place. The Business Rules config type predates this module and keeps its own
// inline copies; new config types build on top of it.
// =============================================================================

/**
 * Normalize a ServiceNow boolean, which arrives as a real boolean or the
 * strings "true"/"false"/"1"/"0" (and from the canvas as a checkbox boolean).
 */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1'
}

/** Normalize an integer value (string or number), defaulting when unparseable. */
export function normalizeInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) ? n : fallback
}

/** Trim any value to a string (null/undefined → ""). */
export function trimStr(value: unknown): string {
  return String(value ?? '').trim()
}

/** Build a ServiceNow encoded query `col=val^col2=val2` from (column, value) pairs. */
export function encodedQuery(pairs: Array<[string, string]>): string {
  return pairs.map(([col, val]) => `${col}=${val.trim()}`).join('^')
}

/**
 * Find the record in a result set matching ALL (column, value) identity pairs
 * (trimmed string comparison). Used to resolve the target of an upsert.
 */
export function findByIdentity<T extends Record<string, unknown>>(
  records: T[],
  pairs: Array<[string, string]>,
): T | null {
  return records.find((r) => pairs.every(([col, val]) => trimStr(r[col]) === val.trim())) ?? null
}

/** Snapshot the managed columns of a live record (empty string when absent) — for rollback. */
export function managedSnapshot(
  record: Record<string, unknown>,
  columns: readonly string[],
): Record<string, unknown> {
  const snap: Record<string, unknown> = {}
  for (const col of columns) snap[col] = record[col] ?? ''
  return snap
}

/**
 * Read a canvas "tags" field value as a trimmed, de-duplicated, order-preserving
 * string array. Accepts a real array (the canvas's native shape) or a
 * comma/newline-delimited string (defensive — e.g. a value round-tripped
 * through defaults.yaml or an older snapshot).
 */
export function readStringArray(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v : String(v ?? '')))
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const trimmed = entry.trim()
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

/** Join a tags array into the flat comma-separated form ServiceNow list-type columns store. */
export function joinCsv(values: string[]): string {
  return values.join(',')
}

/** Parse a ServiceNow comma-separated list column (e.g. recipient_users) into a sorted, deduped set. */
export function normalizeCsvSet(value: unknown): string[] {
  return readStringArray(value).slice().sort()
}

/** Order-insensitive equality for two comma-separated list columns — used for drift on `setColumns`. */
export function csvSetEqual(expected: unknown, actual: unknown): boolean {
  const a = normalizeCsvSet(expected)
  const b = normalizeCsvSet(actual)
  return a.length === b.length && a.every((v, i) => v === b[i])
}
