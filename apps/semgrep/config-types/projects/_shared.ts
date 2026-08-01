// Shared helpers for the Semgrep Project Settings config type
// (validate + deploy + rollback + drift).
//
// Identity is the project NAME (the repository as a path, e.g. my-org/my-repo).
// The two managed attributes map straight onto documented Semgrep API fields:
//   primaryBranch → PATCH .../projects/{name}  body { primary_branch }
//   tags          → reconciled with PUT/DELETE .../projects/{name}/tags
// A per-item `manageTags` flag opts a project OUT of tag reconciliation so a
// project authored only to set its primary branch never has tags removed.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

/** One project's desired settings, parsed from a canvas item's fields. */
export interface ProjectSpec {
  /** The project name (repository path). The stable identity. */
  projectName: string
  /**
   * The desired primary branch (full ref, e.g. refs/heads/main), or "" to leave
   * the primary branch unmanaged (deploy sends nothing, drift does not assert it).
   */
  primaryBranch: string
  /** Whether the tag set is reconciled declaratively for this project. */
  manageTags: boolean
  /** The desired tag set (deduplicated, order-independent). */
  tags: string[]
}

/** A canvas item shape shared by every handler (items model, with .fields). */
interface CanvasItemLike {
  id?: string
  name?: string
  fields: Record<string, unknown>
}

/** Read the repeatable items from a canvas snapshot (items model, sections fallback). */
export function canvasItems(canvas: CanvasSnapshot): CanvasItemLike[] {
  const c = canvas as unknown as { items?: CanvasItemLike[]; sections?: Array<{ name?: string; fields?: Record<string, unknown> }> }
  if (Array.isArray(c.items)) return c.items
  if (Array.isArray(c.sections)) return c.sections.map((s) => ({ name: s.name, fields: s.fields ?? {} }))
  return []
}

/** Trim + lowercase a project name so two that differ only in case still match. */
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
 * Read a canvas value that may be a `tags` array, a single string, or a comma
 * list into a trimmed, de-duplicated string[] (original order preserved).
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

/** Build a ProjectSpec from one canvas item's fields. */
export function projectSpecFromFields(fields: Record<string, unknown>): ProjectSpec {
  return {
    projectName: String(fields.projectName ?? '').trim(),
    primaryBranch: String(fields.primaryBranch ?? '').trim(),
    manageTags: readBool(fields.manageTags, true),
    tags: strList(fields.tags),
  }
}

/** Every project spec authored on the canvas. */
export function extractProjectSpecs(canvas: CanvasSnapshot): ProjectSpec[] {
  return canvasItems(canvas).map((item) => projectSpecFromFields(item.fields ?? {}))
}

/**
 * Diff a desired tag set against the live set. Comparison is case-insensitive;
 * the returned tags keep their desired / live casing. `toAdd` are desired tags
 * missing live; `toRemove` are live tags not desired.
 */
export function diffTags(desired: string[], live: string[]): { toAdd: string[]; toRemove: string[] } {
  const desiredKeys = new Set(desired.map((t) => t.toLowerCase()))
  const liveKeys = new Set(live.map((t) => t.toLowerCase()))
  const toAdd = desired.filter((t) => !liveKeys.has(t.toLowerCase()))
  const toRemove = live.filter((t) => !desiredKeys.has(t.toLowerCase()))
  return { toAdd, toRemove }
}

/** True when two tag sets are equal ignoring order and case. */
export function tagsEqual(a: string[], b: string[]): boolean {
  const { toAdd, toRemove } = diffTags(a, b)
  return toAdd.length === 0 && toRemove.length === 0
}
