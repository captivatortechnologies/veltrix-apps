// Shared helpers for the TheHive Page Templates (Knowledge Base) config type
// (deploy + rollback + drift).
//
// Page-template shapes follow the TheHive 5 API (InputPageTemplate /
// InputUpdatePageTemplate / OutputPageTemplate at /api/v1/pageTemplate).
//
// V5-ONLY: Page Templates (the Knowledge Base feature) do not exist in TheHive 4
// — confirmed absent from the TheHive 4 OpenAPI spec. This bypasses the
// THEHIVE_PATHS v4/v5 seam entirely (see lib/thehiveApi.ts,
// PAGE_TEMPLATE_PATHS_V5 / isPageTemplateSupported). Every handler in this
// config type checks isPageTemplateSupported() before calling out and fails
// clearly (deploy) or reports "no drift" (driftDetect, best-effort) instead of
// guessing a v4 path.

/** A TheHive page template as authored (InputPageTemplate) or returned (Output…). */
export interface PageTemplate {
  _id?: string
  id?: string | number
  title?: string
  content?: string
  category?: string
  order?: number
  [key: string]: unknown
}

/** InputUpdatePageTemplate (patch) — the mutable subset; title is omitted (see buildPageTemplateUpdateBody). */
export interface PageTemplateUpdate {
  content?: string
  category?: string
  order?: number
}

/** The stable id of a live page template (`_id`), or null. */
export function pageTemplateId(t: PageTemplate | null | undefined): string | null {
  if (!t) return null
  if (t._id != null && String(t._id).trim()) return String(t._id)
  if (t.id != null && String(t.id).trim()) return String(t.id)
  return null
}

/** Coerce a canvas value to a non-negative integer order; defaults to 0. */
export function parseOrder(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0
}

/** Find a live page template by title (the stable identity). */
export function findPageTemplate(templates: PageTemplate[], title: string): PageTemplate | null {
  const t = title.trim()
  if (!t) return null
  return templates.find((tpl) => String(tpl.title ?? '').trim() === t) ?? null
}

/** Unwrap a list/query response into a flat array of page templates. */
export function pageTemplatesFromList(list: unknown): PageTemplate[] {
  if (Array.isArray(list)) return list as PageTemplate[]
  if (list && typeof list === 'object') {
    const rows = (list as Record<string, unknown>).data ?? (list as Record<string, unknown>).results
    if (Array.isArray(rows)) return rows as PageTemplate[]
  }
  return []
}

/** Build the InputPageTemplate (create) body from canvas fields. */
export function buildPageTemplateCreateBody(fields: Record<string, unknown>): { title: string; content: string; category: string; order: number } {
  return {
    title: String(fields.title ?? '').trim(),
    content: String(fields.content ?? '').trim(),
    category: String(fields.category ?? '').trim(),
    order: parseOrder(fields.order),
  }
}

/**
 * Build the InputUpdatePageTemplate (patch) body. `title` is deliberately
 * omitted: this config type upserts by title (the stable identity used for
 * lookup/drift), so a rename in the canvas is indistinguishable from creating a
 * new page template — same convention as the other config types in this app.
 */
export function buildPageTemplateUpdateBody(fields: Record<string, unknown>): PageTemplateUpdate {
  return {
    content: String(fields.content ?? '').trim(),
    category: String(fields.category ?? '').trim(),
    order: parseOrder(fields.order),
  }
}

/** Map a live page template to the updatable subset (used by rollback restore). */
export function toPageTemplateUpdate(t: PageTemplate): PageTemplateUpdate {
  return {
    content: String(t.content ?? ''),
    category: String(t.category ?? ''),
    order: parseOrder(t.order),
  }
}
