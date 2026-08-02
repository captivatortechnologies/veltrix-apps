// =============================================================================
// Shared, network-free helpers for resolving a HackerOne PROGRAM (by handle) and
// its structured SCOPES (by asset identifier) from JSON:API responses.
//
// Every config type that targets a program's scope surface addresses an asset by
// (program_handle + asset_identifier) — Structured Scopes and Credential
// Inquiries both do — so the resolution primitives live here rather than being
// duplicated in any one config-type folder.
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { JsonApiResource } from './hackeroneApi'

/** One program as returned by GET /me/programs. */
export type ProgramResource = JsonApiResource<{ handle?: string; name?: string }>

/** Any JSON:API resource that carries an asset_identifier (e.g. a structured scope). */
export type IdentifiableResource = JsonApiResource<{ asset_identifier?: string }>

/** Trim a value to a string (never null/undefined leaking through). */
export function str(value: unknown): string {
  return String(value ?? '').trim()
}

/** Normalize an asset identifier so two that differ only in case/whitespace match. */
export function normalizeIdentifier(value: unknown): string {
  return str(value).toLowerCase()
}

/**
 * Coerce a canvas checkbox value (boolean, or 'true'/'false'/'1'/'0' string, or
 * undefined) to a boolean. `fallback` is returned for an empty/undefined value.
 */
export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (value === undefined || value === null || value === '') return fallback
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Group canvas items by their (trimmed) program_handle, preserving order. */
export function groupItemsByProgram(items: CanvasItemSnapshot[]): Map<string, CanvasItemSnapshot[]> {
  const byProgram = new Map<string, CanvasItemSnapshot[]>()
  for (const item of items) {
    const handle = str(item.fields.program_handle)
    if (!handle) continue
    const list = byProgram.get(handle) ?? []
    list.push(item)
    byProgram.set(handle, list)
  }
  return byProgram
}

/** Resolve a program handle to its numeric program id from a /me/programs listing. */
export function findProgramId(programs: ProgramResource[], handle: string): string | null {
  const h = str(handle).toLowerCase()
  if (!h) return null
  const match = programs.find((p) => str(p.attributes?.handle).toLowerCase() === h)
  return match?.id != null ? String(match.id) : null
}

/** Index a program's live scopes by their normalized asset_identifier. */
export function scopesByIdentifier<T extends IdentifiableResource>(scopes: T[]): Map<string, T> {
  const map = new Map<string, T>()
  for (const scope of scopes) {
    const id = normalizeIdentifier(scope.attributes?.asset_identifier)
    if (id) map.set(id, scope)
  }
  return map
}
