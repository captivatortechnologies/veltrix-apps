// Shared helpers for the Wazuh CDB-lists config type (validate + deploy + drift).
//
// A CDB list is a plain-text file of newline-separated `key:value` pairs that
// Wazuh compiles into a constant database for O(1) lookups from rules/decoders.
// The value may be empty (a bare `key:` denotes a keyed membership set). Wazuh
// CDB files do not support inline comments, so the canvas `comment` field is
// audit-only metadata and is never written into the file body.

/** A CDB list name / on-disk basename: letters, numbers, dot, underscore, hyphen. */
export const LIST_NAME_RE = /^[a-zA-Z0-9._-]+$/

/** A safe relative path (no absolute, no traversal): path segments over the safe charset. */
export const PATH_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/

export interface CdbEntry {
  key: string
  value: string
}

export interface ParsedEntries {
  entries: CdbEntry[]
  /** 1-based line numbers that are non-blank but not a valid `key:value` pair. */
  invalidLines: number[]
}

/**
 * Parse the `entries` textarea into CDB pairs. Blank lines are skipped. Each
 * remaining line must contain a colon with a non-empty key; everything after the
 * first colon is the (possibly empty) value. Pure and network-free.
 */
export function parseEntries(text: unknown): ParsedEntries {
  const entries: CdbEntry[] = []
  const invalidLines: number[] = []
  const lines = String(text ?? '').split(/\r?\n/)
  lines.forEach((raw, idx) => {
    const line = raw.trim()
    if (!line) return
    const colon = line.indexOf(':')
    if (colon <= 0) {
      invalidLines.push(idx + 1)
      return
    }
    entries.push({ key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() })
  })
  return { entries, invalidLines }
}

/** Serialize CDB pairs back to the canonical `key:value` file body (trailing newline). */
export function serializeEntries(entries: CdbEntry[]): string {
  return entries.map((e) => `${e.key}:${e.value}`).join('\n') + (entries.length ? '\n' : '')
}

/** Reduce CDB pairs to a key→value map (last write wins), for drift comparison. */
export function entriesToMap(entries: CdbEntry[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const { key, value } of entries) map[key] = value
  return map
}

/**
 * Derive the API filename for the /lists/files/{filename} endpoint from the
 * canvas fields. The Wazuh API filename is relative to the ruleset lists dir
 * (etc/lists/), so a `path` of "etc/lists/blocklist" resolves to "blocklist".
 * Falls back to the listName. Verify the exact base dir against a live Wazuh 4.x
 * manager.
 */
export function deriveFilename(path: unknown, listName: unknown): string {
  const raw = String(path ?? '').trim().replace(/^\/+/, '')
  const stripped = raw.replace(/^etc\/lists\/+/, '')
  const candidate = stripped || String(listName ?? '').trim()
  return candidate
}

/** Whether a relative path is safe: non-empty, no absolute root, no `..` traversal. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/')) return false
  const segments = path.split('/').filter(Boolean)
  if (segments.length === 0) return false
  return segments.every((seg) => seg !== '..' && PATH_SEGMENT_RE.test(seg))
}
