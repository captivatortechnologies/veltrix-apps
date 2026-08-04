// =============================================================================
// Shared, network-free helpers for resolving a HackerOne ORGANIZATION (by handle)
// and, within it, an organization-level ASSET (by identifier) from JSON:API
// responses — the confirmed, non-deprecated successor to the program-level
// structured-scope write endpoints (removed from HackerOne's docs 2026-04-07).
//
// The Assets and Asset Scopes config types both address their target by
// (organization_handle [+ program_handle] + asset identifier), so the
// resolution primitives live here rather than being duplicated in either
// config-type folder — mirroring lib/programScopes.ts for the program-scoped
// config types (Structured Scopes, Credential Inquiries).
// =============================================================================

import type { CanvasItemSnapshot } from '@veltrixsecops/app-sdk'
import type { JsonApiResource } from './hackeroneApi'
import { str, normalizeIdentifier } from './programScopes'

/** One organization as returned by GET /me/organizations. */
export type OrganizationResource = JsonApiResource<{ handle?: string }>

/** Group canvas items by their (trimmed) organization_handle, preserving order. */
export function groupItemsByOrganization(items: CanvasItemSnapshot[]): Map<string, CanvasItemSnapshot[]> {
  const byOrg = new Map<string, CanvasItemSnapshot[]>()
  for (const item of items) {
    const handle = str(item.fields.organization_handle)
    if (!handle) continue
    const list = byOrg.get(handle) ?? []
    list.push(item)
    byOrg.set(handle, list)
  }
  return byOrg
}

/** Resolve an organization handle to its numeric organization id from a /me/organizations listing. */
export function findOrganizationId(organizations: OrganizationResource[], handle: string): string | null {
  const h = str(handle).toLowerCase()
  if (!h) return null
  const match = organizations.find((o) => str(o.attributes?.handle).toLowerCase() === h)
  return match?.id != null ? String(match.id) : null
}

/**
 * An organization asset, as returned by GET /organizations/{id}/assets. `identifier`
 * is the generic, always-present field to reconcile by — HackerOne ALSO echoes it
 * back under a type-specific alias (`domain_name` for `asset_type: "domain"`, `url`
 * for `asset_type: "url"`, etc.), which this app does not depend on.
 *   Confirmed: https://api.hackerone.com/customer-reference/ (asset)
 */
export type AssetAttributes = {
  asset_type?: string
  identifier?: string
  description?: string | null
  coverage?: string
  state?: string
  max_severity?: string | null
  confidentiality_requirement?: string
  integrity_requirement?: string
  availability_requirement?: string
  reference?: string
  archived_at?: string | null
  [key: string]: unknown
}

export type AssetResource = JsonApiResource<AssetAttributes>

/**
 * Resolve a single organization asset by its exact (case-insensitive) `identifier`
 * from a `filter[identifier]`-scoped listing. HackerOne's filter is a query, not a
 * uniqueness guarantee, so this still matches defensively rather than trusting the
 * first result.
 */
export function pickAssetByIdentifier(assets: AssetResource[], identifier: string): AssetResource | null {
  const target = normalizeIdentifier(identifier)
  if (!target) return null
  return assets.find((a) => normalizeIdentifier(a.attributes?.identifier) === target) ?? null
}
