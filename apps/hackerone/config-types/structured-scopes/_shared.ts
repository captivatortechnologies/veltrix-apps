// Shared helpers for the HackerOne Structured Scopes config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// A Structured Scope is one asset in a program's scope. Its attributes follow the
// HackerOne "structured-scope" resource:
//   asset_type, asset_identifier, eligible_for_bounty, eligible_for_submission,
//   max_severity, instruction (+ CIA requirements + reference, read-only here).
//   Confirmed shape: https://api.hackerone.com/customer-resources/ (Structured Scopes)
//   Confirmed attribute list: github/hackerone-client StructuredScope model.

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { JsonApiResource } from '../../lib/hackeroneApi'

/**
 * Machine enum values HackerOne accepts for a scope `asset_type`. Kept in sync
 * with the canvas.yaml select options and used by validate.ts.
 *
 * FLAGGED — the exact machine enum set has changed across HackerOne API
 * revisions; verify against live HackerOne before production use.
 *   Reference: https://docs.hackerone.com/en/articles/8486276-asset-types
 */
export const ASSET_TYPES = new Set([
  'URL',
  'CIDR',
  'DOMAIN',
  'WILDCARD',
  'GOOGLE_PLAY_APP_ID',
  'OTHER_APK',
  'APPLE_STORE_APP_ID',
  'TESTFLIGHT',
  'OTHER_IPA',
  'WINDOWS_APP_STORE_APP_ID',
  'SOURCE_CODE',
  'DOWNLOADABLE_EXECUTABLES',
  'HARDWARE',
  'AI_MODEL',
  'SMART_CONTRACT',
  'OTHER',
])

/** Severity ratings HackerOne accepts for a scope `max_severity`. */
export const MAX_SEVERITIES = new Set(['none', 'low', 'medium', 'high', 'critical'])

/** The writable attributes of a HackerOne structured-scope. */
export interface ScopeAttributes {
  asset_type: string
  asset_identifier: string
  eligible_for_bounty: boolean
  eligible_for_submission: boolean
  max_severity: string
  instruction: string | null
  [key: string]: unknown
}

/** One live structured-scope as returned by GET /programs/{id}/structured_scopes. */
export type LiveScope = JsonApiResource<Partial<ScopeAttributes>>

/** One program as returned by GET /me/programs. */
export type ProgramResource = JsonApiResource<{ handle?: string; name?: string }>

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

/** Build the writable scope attributes from a canvas item's fields. */
export function buildScopeAttributes(fields: Record<string, unknown>): ScopeAttributes {
  const instruction = str(fields.instruction)
  return {
    asset_type: str(fields.asset_type),
    asset_identifier: str(fields.asset_identifier),
    eligible_for_bounty: toBool(fields.eligible_for_bounty, false),
    eligible_for_submission: toBool(fields.eligible_for_submission, true),
    max_severity: str(fields.max_severity) || 'none',
    instruction: instruction ? instruction : null,
  }
}

/**
 * Build a JSON:API write document for a structured-scope:
 *   { data: { type: "structured-scope", attributes: {...} } }
 *
 * FLAGGED — verify the exact request envelope (top-level `{ type, attributes }`
 * vs. the JSON:API `{ data: {...} }` form used here) against live HackerOne.
 */
export function scopeWriteBody(attributes: Record<string, unknown>): { data: { type: string; attributes: Record<string, unknown> } } {
  return { data: { type: 'structured-scope', attributes } }
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
export function scopesByIdentifier(scopes: LiveScope[]): Map<string, LiveScope> {
  const map = new Map<string, LiveScope>()
  for (const scope of scopes) {
    const id = normalizeIdentifier(scope.attributes?.asset_identifier)
    if (id) map.set(id, scope)
  }
  return map
}
