// Shared helpers for the HackerOne Assets config type (deploy + rollback +
// drift). Pure + network-free so they can be unit-tested.
//
// An organization Asset is the confirmed, non-deprecated successor to the
// program-level structured-scope CREATE/UPDATE endpoints (removed from
// HackerOne's docs 2026-04-07). It lives at the ORGANIZATION level; attaching it
// to a program's scope is a separate step (the Asset Scopes config type).
//   Confirmed: https://api.hackerone.com/customer-reference/ (asset)
//     GET  /organizations/{organization_id}/assets?filter[identifier]=...
//     POST /organizations/{organization_id}/assets
//            { data: { type: "asset", attributes: { asset_type, identifier,
//                                                    description, max_severity,
//                                                    confidentiality_requirement,
//                                                    integrity_requirement,
//                                                    availability_requirement,
//                                                    reference } } }
//     PUT  /organizations/{organization_id}/assets/{asset_id}
//            same attributes MINUS asset_type / identifier (immutable post-create)
//     POST /organizations/{organization_id}/assets/archive
//            { data: [ { id, type: "asset" } ] }   (bulk; this app's delete path —
//              there is no per-id DELETE endpoint)
//
// FLAGGED — the Assets endpoints do not state a "Required permissions" scope in
// HackerOne's published docs, unlike every other resource in the reference.
// Verify against a live token before relying on it in production.
//
// The generic organization resolution primitives (handle → id, asset lookup by
// identifier) are shared with the Asset Scopes config type and live in
// lib/organizations.ts.

import { str } from '../../lib/programScopes'

export { str } from '../../lib/programScopes'
export {
  groupItemsByOrganization,
  findOrganizationId,
  pickAssetByIdentifier,
  type OrganizationResource,
  type AssetResource,
  type AssetAttributes,
} from '../../lib/organizations'

/** JSON:API resource `type` for an organization asset. */
export const ASSET_TYPE = 'asset'

/**
 * Machine enum values HackerOne accepts for an asset's `asset_type`. This is a
 * DISTINCT schema from the legacy program-level Structured Scope `asset_type`
 * enum (camelCase here vs. UPPER_SNAKE_CASE there) — kept in sync with the
 * canvas.yaml select options and used by validate.ts.
 *   Confirmed: https://api.hackerone.com/customer-reference/ (asset, Enumerated Values)
 */
export const ASSET_TYPES = new Set([
  'domain',
  'url',
  'cidr',
  'hardware',
  'sourceCode',
  'iosAppStore',
  'iosTestflight',
  'iosIpa',
  'androidPlayStore',
  'androidApk',
  'windowsMicrosoftStore',
  'executable',
  'other',
  'smartContract',
  'api',
  'aiModel',
  'awsCloudConfig',
  'azureCloudConfig',
])

/** Severity ratings HackerOne accepts for an asset's `max_severity`. */
export const MAX_SEVERITIES = new Set(['none', 'low', 'medium', 'high', 'critical'])

/**
 * CVSS environmental-requirement levels for confidentiality / integrity /
 * availability. NOTE: unlike `max_severity`, these do NOT include "critical".
 */
export const CIA_LEVELS = new Set(['none', 'low', 'medium', 'high'])

/** The writable attributes sent on asset CREATE (includes immutable identity fields). */
export interface AssetCreateAttributes {
  asset_type: string
  identifier: string
  description: string | null
  max_severity: string
  confidentiality_requirement: string
  integrity_requirement: string
  availability_requirement: string
  reference: string | null
  [key: string]: unknown
}

/** The writable attributes sent on asset UPDATE (asset_type/identifier omitted — immutable). */
export type AssetUpdateAttributes = Omit<AssetCreateAttributes, 'asset_type' | 'identifier'>

/** Build the full writable attribute set (create-shape) from a canvas item's fields. */
export function buildAssetCreateAttributes(fields: Record<string, unknown>): AssetCreateAttributes {
  const description = str(fields.description)
  const reference = str(fields.reference)
  return {
    asset_type: str(fields.asset_type),
    identifier: str(fields.identifier),
    description: description ? description : null,
    max_severity: str(fields.max_severity) || 'none',
    confidentiality_requirement: str(fields.confidentiality_requirement) || 'none',
    integrity_requirement: str(fields.integrity_requirement) || 'none',
    availability_requirement: str(fields.availability_requirement) || 'none',
    reference: reference ? reference : null,
  }
}

/** Build the update-shape attribute set (drops the immutable asset_type/identifier). */
export function buildAssetUpdateAttributes(fields: Record<string, unknown>): AssetUpdateAttributes {
  const { asset_type: _assetType, identifier: _identifier, ...rest } = buildAssetCreateAttributes(fields)
  return rest
}

/** JSON:API write document for an asset: { data: { type: "asset", attributes: {...} } }. */
export function assetWriteBody(attributes: Record<string, unknown>): { data: { type: string; attributes: Record<string, unknown> } } {
  return { data: { type: ASSET_TYPE, attributes } }
}

/** Bulk-archive request body: { data: [ { id, type: "asset" } ] } — HackerOne's only delete path. */
export function archiveAssetsBody(assetIds: string[]): { data: Array<{ id: string; type: string }> } {
  return { data: assetIds.map((id) => ({ id, type: ASSET_TYPE })) }
}
