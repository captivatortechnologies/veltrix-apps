// Shared helpers for the HackerOne Structured Scopes config type
// (deploy + rollback + drift). Pure + network-free so they can be unit-tested.
//
// A Structured Scope is one asset in a program's scope. Its attributes follow the
// HackerOne "structured-scope" resource:
//   asset_type, asset_identifier, eligible_for_bounty, eligible_for_submission,
//   max_severity, instruction (+ CIA requirements + reference, read-only here).
//   Confirmed shape: https://api.hackerone.com/customer-resources/ (Structured Scopes)
//   Confirmed attribute list: github/hackerone-client StructuredScope model.
//
// The generic program/scope resolution primitives (program handle → id, scope
// indexing, value coercion) are shared with other config types and live in
// lib/programScopes.ts; they are re-exported here so existing imports of
// `./_shared` keep working.

import type { JsonApiResource } from '../../lib/hackeroneApi'
import { str, toBool } from '../../lib/programScopes'

export {
  str,
  normalizeIdentifier,
  toBool,
  groupItemsByProgram,
  findProgramId,
  scopesByIdentifier,
  type ProgramResource,
} from '../../lib/programScopes'

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
