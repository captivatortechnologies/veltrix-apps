// Generic, config-type-agnostic helpers for reading a Configuration Canvas
// snapshot. Shared by every Semgrep config type (projects, managed-scan, triage)
// so the parsing rules stay in one place.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** A canvas item shape shared by every handler (items model, with .fields). */
export interface CanvasItemLike {
  id?: string
  name?: string
  fields: Record<string, unknown>
}

/** Read the repeatable items from a canvas snapshot (items model, sections fallback). */
export function canvasItems(canvas: CanvasSnapshot): CanvasItemLike[] {
  const c = canvas as unknown as {
    items?: CanvasItemLike[]
    sections?: Array<{ name?: string; fields?: Record<string, unknown> }>
  }
  if (Array.isArray(c.items)) return c.items
  if (Array.isArray(c.sections)) return c.sections.map((s) => ({ name: s.name, fields: s.fields ?? {} }))
  return []
}

/** Trim + lowercase an identity value so two that differ only in case still match. */
export function normalizeName(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

/** Read a boolean-ish canvas value (checkbox / string), falling back when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/**
 * Read a canvas value that may be an array, a single string, or a comma list into
 * a trimmed, de-duplicated string[] (original order preserved, case-insensitive
 * de-dup).
 */
export function strList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((v) => (typeof v === 'string' ? v.trim() : ''))
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of raw) {
    if (!t) continue
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}
