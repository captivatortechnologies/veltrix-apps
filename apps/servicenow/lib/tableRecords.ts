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
