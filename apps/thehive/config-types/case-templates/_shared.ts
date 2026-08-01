// Shared helpers for the TheHive Case Templates config type (deploy + rollback + drift).
//
// Case template shapes follow the TheHive 5 API (InputCaseTemplate / OutputCaseTemplate
// at /api/v1/caseTemplate). TheHive 4 uses the same field names at /api/case/template.
// Verify against a live TheHive (see README, v4 vs v5).

/** Allowed enum ranges (inclusive). */
export const SEVERITY_MIN = 1
export const SEVERITY_MAX = 4
export const TLP_MIN = 0
export const TLP_MAX = 3
export const PAP_MIN = 0
export const PAP_MAX = 3

/** One task title pre-created on cases made from a template. */
export interface CaseTemplateTask {
  title: string
  [key: string]: unknown
}

/** A TheHive case template as authored (InputCaseTemplate) or returned (Output…). */
export interface CaseTemplate {
  // v5 returns `_id`; v4 returns `id`. Both are read via templateId().
  _id?: string
  id?: string | number
  name?: string
  displayName?: string
  titlePrefix?: string
  description?: string
  severity?: number
  tlp?: number
  pap?: number
  tags?: string[]
  tasks?: CaseTemplateTask[]
  [key: string]: unknown
}

/** The stable id of a live template (v5 `_id`, else v4 `id`), or null. */
export function templateId(tpl: CaseTemplate | null | undefined): string | null {
  if (!tpl) return null
  if (tpl._id != null && String(tpl._id).trim()) return String(tpl._id)
  if (tpl.id != null && String(tpl.id).trim()) return String(tpl.id)
  return null
}

/** Coerce a canvas value to an integer within [min, max]; returns fallback otherwise. */
export function toBoundedInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Split a tags textarea (newline and/or comma separated) into a deduped list. */
export function parseTags(value: unknown): string[] {
  const raw = String(value ?? '')
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[\n,]/)) {
    const tag = part.trim()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      out.push(tag)
    }
  }
  return out
}

/** Split a tasks textarea (one title per line) into TheHive task objects. */
export function parseTasks(value: unknown): CaseTemplateTask[] {
  const raw = String(value ?? '')
  const seen = new Set<string>()
  const out: CaseTemplateTask[] = []
  for (const line of raw.split(/\r?\n/)) {
    const title = line.trim()
    if (title && !seen.has(title)) {
      seen.add(title)
      out.push({ title })
    }
  }
  return out
}

/** Find a live template by name (the stable identity). */
export function findCaseTemplate(templates: CaseTemplate[], name: string): CaseTemplate | null {
  const n = name.trim()
  if (!n) return null
  return templates.find((t) => String(t.name ?? '').trim() === n) ?? null
}

/** Unwrap a query/search response into a flat array of templates. */
export function templatesFromList(list: unknown): CaseTemplate[] {
  if (Array.isArray(list)) return list as CaseTemplate[]
  // v4 _search may wrap results; be tolerant.
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as CaseTemplate[]
  }
  return []
}

/** Build the InputCaseTemplate body TheHive expects from canvas fields. */
export function buildCaseTemplateBody(fields: Record<string, unknown>): CaseTemplate {
  const name = String(fields.name ?? '').trim()
  const displayName = String(fields.displayName ?? '').trim()
  const titlePrefix = String(fields.titlePrefix ?? '').trim()
  const description = String(fields.description ?? '').trim()
  const body: CaseTemplate = {
    name,
    displayName: displayName || name,
    severity: toBoundedInt(fields.severity, SEVERITY_MIN, SEVERITY_MAX, 2),
    tlp: toBoundedInt(fields.tlp, TLP_MIN, TLP_MAX, 2),
    pap: toBoundedInt(fields.pap, PAP_MIN, PAP_MAX, 2),
    tags: parseTags(fields.tags),
    tasks: parseTasks(fields.tasks),
  }
  if (titlePrefix) body.titlePrefix = titlePrefix
  if (description) body.description = description
  return body
}
