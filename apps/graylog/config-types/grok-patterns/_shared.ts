// Shared helpers for the Graylog Grok Patterns config type (validate + deploy +
// rollback + drift). Shapes follow the Graylog REST API (/api/system/grok):
//   • POST body      = GrokPattern { name, pattern } (id ignored on create)
//   • PUT   body      = GrokPattern { name, pattern } (id comes from the URL —
//                       GrokResource.updatePattern rebuilds the pattern from the
//                       path id + the body's name/pattern, ignoring any id in
//                       the body)
//   • GET  response  = GrokPatternList { patterns: [GrokPattern] } (deprecated
//                       bare list) — used here for its simplicity; the
//                       `/paginated` variant is not needed for full-list reads.
// Source: org.graylog2.rest.resources.system.GrokResource (@ 6.1),
// org.graylog2.grok.GrokPattern.

import { asString } from '../../lib/coerce'

/** One grok pattern as returned by GET /api/system/grok (GrokPattern). */
export interface GraylogGrokPattern {
  id?: string
  name?: string
  pattern?: string
  content_pack?: string
  [key: string]: unknown
}

/** GET /api/system/grok envelope: `{ patterns: [...] }`. */
interface GrokPatternListResponse {
  patterns?: GraylogGrokPattern[]
}

/** Body sent to POST/PUT /api/system/grok[/{patternId}]. */
export interface GrokPatternBody {
  name: string
  pattern: string
}

/** Unwrap GET /api/system/grok into a flat array of patterns. */
export function grokPatternsFromList(list: unknown): GraylogGrokPattern[] {
  if (Array.isArray(list)) return list as GraylogGrokPattern[]
  const patterns = (list as GrokPatternListResponse | null)?.patterns
  return Array.isArray(patterns) ? patterns : []
}

/** Find a live grok pattern by name (the stable identity used for upsert + drift). */
export function findGrokPattern(patterns: GraylogGrokPattern[], name: string): GraylogGrokPattern | null {
  const n = asString(name)
  if (!n) return null
  return patterns.find((p) => asString(p.name) === n) ?? null
}

/** Build the GrokPattern body from canvas fields. */
export function buildGrokPatternBody(fields: Record<string, unknown>): GrokPatternBody {
  return {
    name: asString(fields.name),
    pattern: String(fields.pattern ?? '').trim(),
  }
}

/** Build a restore body from a live grok pattern (rollback). */
export function bodyFromLiveGrokPattern(pattern: GraylogGrokPattern): GrokPatternBody {
  return {
    name: asString(pattern.name),
    pattern: String(pattern.pattern ?? '').trim(),
  }
}
