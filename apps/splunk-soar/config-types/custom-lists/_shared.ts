// Shared helpers for the Custom Lists config type (deploy + rollback + drift).
//
// REST shape follows /rest/decided_list (docs.splunk.com SOAR PlatformAPI —
// List endpoints): name, content (a 2D array of row cells). Update REPLACES
// the full `content` in one call — no per-row append/update/delete is used
// here, matching this app's declarative "canvas = full desired state" model.
// GET (list)/POST (create)/POST-<id-or-name> (update)/DELETE-<id> confirmed.
// Notably, Custom Lists' DELETE accepts EITHER a user-authenticated credential
// OR an automation API token — the one resource type in this app where
// rollback-of-a-create is NOT blocked by a token-only credential (see
// lib/soarApi.ts DELETE_AUTH_HINT for the general rule this is the exception
// to). Verify against a live SOAR instance.

import { parseCsvRows } from '../../lib/soarCommon'

export interface ListSpec {
  id: string
  content: string[][] | null
  error: string | null
}

export interface SoarCustomList {
  id?: number | string
  name?: string
  [key: string]: unknown
}

/** Find a live list by name (case-insensitive — the stable identity). */
export function findListByName(lists: SoarCustomList[], name: string): SoarCustomList | null {
  const target = name.trim().toLowerCase()
  if (!target) return null
  return lists.find((l) => String(l.name ?? '').trim().toLowerCase() === target) ?? null
}

export function buildListSpec(fields: Record<string, unknown>): ListSpec {
  const name = String(fields.name ?? '').trim()
  if (!name) return { id: '', content: null, error: null }

  const rows = parseCsvRows(fields.content)
  if (rows.length === 0) {
    return { id: name, content: null, error: 'At least one row of content is required.' }
  }

  return { id: name, content: rows, error: null }
}

/**
 * Parse the `formatted_content?_output_format=json` response into rows. The
 * exact JSON shape is not fully documented — defensively accepts a bare 2D
 * array or a `{ content: [...] }` wrapper, falling back to CSV-line parsing
 * for a plain-text response. Verify against a live instance.
 */
export function parseFormattedContent(raw: unknown): string[][] {
  if (Array.isArray(raw)) return raw.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)]))
  if (raw && typeof raw === 'object' && Array.isArray((raw as { content?: unknown }).content)) {
    return parseFormattedContent((raw as { content: unknown }).content)
  }
  if (typeof raw === 'string') return parseCsvRows(raw)
  return []
}
