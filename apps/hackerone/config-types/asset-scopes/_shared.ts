// Shared helpers for the HackerOne Asset Scopes config type (deploy + rollback +
// drift). Pure + network-free so they can be unit-tested.
//
// An Asset Scope attaches an organization Asset (see the Assets config type) to
// a program's scope — the confirmed, non-deprecated successor to the
// program-level structured-scope CREATE/UPDATE endpoints (removed from
// HackerOne's docs 2026-04-07). The live resource returned is still a
// `structured-scope` object — only the WRITE path moved to the org/asset route;
// the READ path (GET /programs/{id}/structured_scopes, still documented) is
// unchanged, so this reuses `scopesByIdentifier` from lib/programScopes.ts to
// reconcile.
//   Confirmed: https://api.hackerone.com/customer-resources/ (Assets)
//     POST /organizations/{organization_id}/assets/{asset_id}/scopes
//            { data: { type: "structured-scope",
//                      attributes: { eligible_for_submission, eligible_for_bounty,
//                                    instruction, notify_subscribers_on_changes } },
//              relationships: { programs: { data: [ { id, type: "program" } ] } } }
//     PUT  /organizations/{organization_id}/assets/{asset_id}/scopes/{id}
//            { data: { type: "structured-scope",
//                      attributes: { eligible_for_submission, eligible_for_bounty,
//                                    instruction, notify_subscribers_of_changes } } }
//            NOTE the key is "notify_subscribers_OF_changes" here, not "_on_" as on
//            create — that is HackerOne's own documented spelling difference, kept
//            verbatim per operation. FLAGGED — likely a documentation typo, not
//            independently verified against a live program.
//     POST /organizations/{organization_id}/assets/{asset_id}/scopes/archive
//            { data: [ { id: <program_id>, type: "program" } ] }
//            NOTE this bulk-archives the attachment for the given PROGRAM ids, not
//            scope ids — this app's only delete path (there is no per-id DELETE).
//
// FLAGGED — these endpoints do not state a "Required permissions" scope in
// HackerOne's published docs, unlike every other resource in the reference.
// Verify against a live token before relying on it in production.

import type { JsonApiResource } from '../../lib/hackeroneApi'
import { str, toBool } from '../../lib/programScopes'

export { str, toBool, findProgramId, scopesByIdentifier, normalizeIdentifier, type ProgramResource } from '../../lib/programScopes'
export { groupItemsByOrganization, findOrganizationId, pickAssetByIdentifier, type OrganizationResource, type AssetResource } from '../../lib/organizations'

/**
 * One live structured-scope as returned by GET /programs/{id}/structured_scopes —
 * the read side of an asset-scope attachment. The WRITE path moved to the
 * org/asset route, but the resource read back is still `type: "structured-scope"`.
 */
export type LiveScope = JsonApiResource<{
  asset_identifier?: string
  eligible_for_submission?: boolean
  eligible_for_bounty?: boolean
  instruction?: string | null
  [key: string]: unknown
}>

/** JSON:API resource `type` for a HackerOne (asset-scope) structured scope. */
export const STRUCTURED_SCOPE_TYPE = 'structured-scope'

/** The eligibility / instruction attributes shared by create and update. */
export interface AssetScopeAttributes {
  eligible_for_submission: boolean
  eligible_for_bounty: boolean
  instruction: string | null
}

/** Build the shared eligibility / instruction attributes from a canvas item's fields. */
export function buildAssetScopeAttributes(fields: Record<string, unknown>): AssetScopeAttributes {
  const instruction = str(fields.instruction)
  return {
    eligible_for_submission: toBool(fields.eligible_for_submission, true),
    eligible_for_bounty: toBool(fields.eligible_for_bounty, false),
    instruction: instruction ? instruction : null,
  }
}

/** The declared "notify subscribers" flag, independent of which key name an operation expects. */
export function buildNotifyFlag(fields: Record<string, unknown>): boolean {
  return toBool(fields.notify_subscribers_on_changes, false)
}

/**
 * POST body attaching an asset to a program's scope:
 *   { data: { type, attributes: {..., notify_subscribers_on_changes} },
 *     relationships: { programs: { data: [{ id: programId, type: "program" }] } } }
 */
export function createAssetScopeBody(
  attributes: AssetScopeAttributes,
  notify: boolean,
  programId: string,
): {
  data: { type: string; attributes: AssetScopeAttributes & { notify_subscribers_on_changes: boolean } }
  relationships: { programs: { data: [{ id: string; type: string }] } }
} {
  return {
    data: { type: STRUCTURED_SCOPE_TYPE, attributes: { ...attributes, notify_subscribers_on_changes: notify } },
    relationships: { programs: { data: [{ id: programId, type: 'program' }] } },
  }
}

/**
 * PUT body updating an existing asset-scope attachment. Uses
 * `notify_subscribers_OF_changes` — HackerOne's own documented key for this
 * operation, distinct from the create body's key (see the FLAGGED note above).
 */
export function updateAssetScopeBody(
  attributes: AssetScopeAttributes,
  notify: boolean,
): { data: { type: string; attributes: AssetScopeAttributes & { notify_subscribers_of_changes: boolean } } } {
  return { data: { type: STRUCTURED_SCOPE_TYPE, attributes: { ...attributes, notify_subscribers_of_changes: notify } } }
}

/** Bulk-archive request body: { data: [ { id: <program_id>, type: "program" } ] }. */
export function archiveAssetScopeBody(programIds: string[]): { data: Array<{ id: string; type: string }> } {
  return { data: programIds.map((id) => ({ id, type: 'program' })) }
}
