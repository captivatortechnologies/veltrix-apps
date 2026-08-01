// Shared helpers for the Cybereason Custom Reputations config type
// (validate + deploy + rollback + drift + tests).
//
// A reputation's identity is its `key` (the file hash / domain / IP value);
// Cybereason keys are unique across the whole custom reputation list regardless
// of type. `keyType` is an authoring convenience used for validation and payload
// shaping — the Cybereason API infers the type from the key itself and does not
// take a type field.
//
// VERIFY AGAINST A LIVE CYBEREASON: the classification/download CSV column
// layout (header names) is inferred from public integrations; parseReputationsCsv
// matches columns by header substring so it tolerates ordering/naming drift.

/** Reputation key types the canvas offers. Cybereason file reputations key on MD5 or SHA-1. */
export const KEY_TYPES = new Set(['file', 'domain', 'ipv4'])

/** Reputation verdicts — mapped verbatim to the Cybereason `maliciousType` field. */
export const REPUTATIONS = new Set(['whitelist', 'blacklist'])

const MD5_RE = /^[a-f0-9]{32}$/i
const SHA1_RE = /^[a-f0-9]{40}$/i
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/
const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/i

/** Reputation fields as authored on the canvas. */
export interface ReputationFields {
  keyType?: unknown
  key?: unknown
  reputation?: unknown
  preventExecution?: unknown
  comment?: unknown
}

/** One entry in the JSON array posted to POST /rest/classification/update. */
export interface ClassificationEntry {
  keys: string[]
  maliciousType: 'whitelist' | 'blacklist'
  prevent: boolean
  remove: boolean
  comment?: string
}

/** A custom reputation as read back from GET /rest/classification/download. */
export interface ReputationRow {
  key: string
  reputation: string
  prevent: boolean
  comment: string
}

/** Coerce a canvas boolean (true | 'true' | 'on' | 1) into a real boolean. */
export function normalizeBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes' || s === 'on'
}

/** Normalize a key for comparison: hashes + domains are case-insensitive, IPs are left as-is. */
export function normalizeKey(keyType: string, key: string): string {
  const trimmed = String(key ?? '').trim()
  return keyType === 'ipv4' ? trimmed : trimmed.toLowerCase()
}

/** Is `key` a syntactically valid value for `keyType`? */
export function isValidKey(keyType: string, key: string): boolean {
  const k = String(key ?? '').trim()
  if (!k) return false
  switch (keyType) {
    case 'file':
      return MD5_RE.test(k) || SHA1_RE.test(k)
    case 'ipv4':
      return IPV4_RE.test(k)
    case 'domain':
      return DOMAIN_RE.test(k)
    default:
      return false
  }
}

/**
 * Build the classification/update entry for one reputation item.
 * `prevent` (Application Control block on execution) is only meaningful for a
 * blocklisted file hash — it is forced false for every other combination, so an
 * accidental checkbox on a domain / allowlist never reaches the API.
 */
export function buildEntry(fields: ReputationFields, remove: boolean): ClassificationEntry {
  const keyType = String(fields.keyType ?? '').trim()
  const key = normalizeKey(keyType, String(fields.key ?? ''))
  const maliciousType = (String(fields.reputation ?? '').trim() as 'whitelist' | 'blacklist')
  const prevent = keyType === 'file' && maliciousType === 'blacklist' && normalizeBool(fields.preventExecution)
  const comment = String(fields.comment ?? '').trim()
  const entry: ClassificationEntry = { keys: [key], maliciousType, prevent, remove }
  if (comment) entry.comment = comment
  return entry
}

/** Split one CSV line into fields, honouring double-quoted values with embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cur += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out.map((v) => v.trim())
}

/**
 * Parse the classification/download CSV into reputation rows. Columns are matched
 * by header substring (key / reputation|type|maliciousType / prevent / comment)
 * so the parser survives header ordering + naming differences across Cybereason
 * versions. Rows without a resolvable key column are skipped.
 */
export function parseReputationsCsv(csv: string): ReputationRow[] {
  const lines = String(csv ?? '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase())
  const findCol = (...needles: string[]) => header.findIndex((h) => needles.some((n) => h.includes(n)))

  let keyCol = findCol('key', 'hash', 'domain', 'ip')
  if (keyCol < 0) keyCol = 0
  const repCol = findCol('reputation', 'malicioustype', 'type', 'classification')
  const preventCol = findCol('prevent')
  const commentCol = findCol('comment')

  const rows: ReputationRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i])
    const key = (cols[keyCol] ?? '').trim()
    if (!key) continue
    rows.push({
      key,
      reputation: repCol >= 0 ? (cols[repCol] ?? '').trim().toLowerCase() : '',
      prevent: preventCol >= 0 ? normalizeBool(cols[preventCol]) : false,
      comment: commentCol >= 0 ? (cols[commentCol] ?? '').trim() : '',
    })
  }
  return rows
}

/** Index reputation rows by their normalized key for O(1) lookup during deploy / drift. */
export function indexByKey(rows: ReputationRow[]): Map<string, ReputationRow> {
  const map = new Map<string, ReputationRow>()
  for (const row of rows) map.set(row.key.trim().toLowerCase(), row)
  return map
}
