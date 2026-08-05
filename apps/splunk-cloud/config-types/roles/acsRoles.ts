// =============================================================================
// ACS-native role transport: /adminconfig/v2/roles.
//
// Field-for-field this is a near-exact match for what this type already
// manages over REST (see validate.ts) — every quota and search field uses the
// SAME JSON key name on both transports. The one naming difference is the
// imported-roles list: the REST parameter is `imported_roles`, ACS's
// write field is `importedRoles`, and — a real, easy-to-miss ACS quirk — its
// READ response does NOT echo `importedRoles` back at the top level at all;
// the declared names surface nested, under `imported.roles`, alongside the
// EFFECTIVE (aggregated) settings a role inherits through them. This module's
// AcsRoleResponse type and diff helpers below get this right so
// driftDetect.ts doesn't compare against a field that doesn't exist on reads.
//
// Confirmed against Splunk's own generated ACS client
// (github.com/splunk/terraform-provider-scp `acs/v2/api.gen.go`):
//   RolesRequest  (POST/PATCH body): capabilities, importedRoles,
//     srchIndexesAllowed, srchIndexesDefault, srchFilter, srchTimeWin,
//     srchTimeEarliest, defaultApp, srchJobsQuota, rtSrchJobsQuota,
//     srchDiskQuota, cumulativeSrchJobsQuota, cumulativeRTSrchJobsQuota
//     (+ `name`, POST only — PATCH cannot rename a role, matching REST).
//   RolesResponse (GET/POST/PATCH response): the same fields TOP-LEVEL, plus
//     `imported: { roles, capabilities, rtSrchJobsQuota, srchDiskQuota,
//     srchFilter, srchIndexesAllowed, srchIndexesDefault, srchJobsQuota,
//     srchTimeEarliest, srchTimeWin }` — the effective values inherited via
//     `importedRoles`. NO top-level `importedRoles` field on reads.
//
// `Federated-Search-Manage-Ack: Y` is sent unconditionally on every write —
// see lib/acsIdentity.ts for why.
// =============================================================================

import {
  createAcsIdentityEntity,
  deleteAcsIdentityEntity,
  FEDERATED_SEARCH_MANAGE_ACK_HEADER,
  getAcsIdentityEntity,
  updateAcsIdentityEntity,
} from '../../lib/acsIdentity'
import type { AcsRequestOptions } from '../../lib/acs'
import { ROLE_QUOTA_FIELDS, type RoleSpec } from './validate'

export const ACS_ROLES_COLLECTION_PATH = '/roles'

export function acsRolePath(name: string): string {
  return `${ACS_ROLES_COLLECTION_PATH}/${encodeURIComponent(name)}`
}

/** The effective values a role inherits through `importedRoles` (GET only). */
export interface AcsImportedRoleInfo {
  roles?: string[]
  capabilities?: string[]
  rtSrchJobsQuota?: number
  srchDiskQuota?: number
  srchFilter?: string
  srchIndexesAllowed?: string[]
  srchIndexesDefault?: string[]
  srchJobsQuota?: number
  srchTimeEarliest?: number
  srchTimeWin?: number
}

/** Shape of GET/POST/PATCH `/adminconfig/v2/roles/{name}` — a flat object, no wrapper. */
export interface AcsRoleResponse {
  name: string
  capabilities?: string[]
  cumulativeRTSrchJobsQuota?: number
  cumulativeSrchJobsQuota?: number
  defaultApp?: string
  imported?: AcsImportedRoleInfo
  rtSrchJobsQuota?: number
  srchDiskQuota?: number
  srchFilter?: string
  srchIndexesAllowed?: string[]
  srchIndexesDefault?: string[]
  srchJobsQuota?: number
  srchTimeEarliest?: number
  srchTimeWin?: number
}

/** JSON keys captured from a live role for rollback (mirrors the write-side field names). */
export const ACS_ROLE_ROLLBACK_KEYS = [
  'importedRoles',
  'capabilities',
  'srchIndexesAllowed',
  'srchIndexesDefault',
  'srchFilter',
  'srchTimeWin',
  'srchTimeEarliest',
  'defaultApp',
  ...ROLE_QUOTA_FIELDS,
] as const

/**
 * Map a RoleSpec to the ACS JSON body. Only fields the canvas actually
 * declares are included — an omitted field is left untouched on PATCH (ACS's
 * PATCH is a true partial update on scalars; list fields are wholesale
 * replaced when present, exactly like REST — see validate.ts's equivalent
 * REST payload builder for the same semantics).
 */
export function buildAcsRolePayload(spec: RoleSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  if (spec.importedRoles) payload.importedRoles = spec.importedRoles
  if (spec.capabilities) payload.capabilities = spec.capabilities
  if (spec.srchIndexesAllowed) payload.srchIndexesAllowed = spec.srchIndexesAllowed
  if (spec.srchIndexesDefault) payload.srchIndexesDefault = spec.srchIndexesDefault
  if (spec.srchFilter !== undefined) payload.srchFilter = spec.srchFilter
  if (spec.srchTimeWin !== undefined) payload.srchTimeWin = spec.srchTimeWin
  if (spec.srchTimeEarliest !== undefined) payload.srchTimeEarliest = spec.srchTimeEarliest
  if (spec.defaultApp !== undefined) payload.defaultApp = spec.defaultApp

  for (const key of ROLE_QUOTA_FIELDS) {
    const value = spec.quotas[key]
    if (value !== undefined) payload[key] = value
  }

  return payload
}

/**
 * Rebuild an ACS PATCH body from a rollback snapshot captured from
 * AcsRoleResponse (see toRollbackPrior below). A previously-empty list is
 * restored as an explicit `[]` (ACS list fields are wholesale-replaced, so
 * omitting the key would leave the deploy's values in place, same as REST).
 */
export function buildAcsRoleRestorePayload(prior: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {}

  for (const key of ['importedRoles', 'capabilities', 'srchIndexesAllowed', 'srchIndexesDefault'] as const) {
    if (!(key in prior)) continue
    const value = prior[key]
    payload[key] = Array.isArray(value) ? value : []
  }

  for (const key of ['srchFilter', 'defaultApp', 'srchTimeWin', 'srchTimeEarliest', ...ROLE_QUOTA_FIELDS] as const) {
    if (key in prior && prior[key] !== undefined && prior[key] !== null) {
      payload[key] = prior[key]
    }
  }

  return payload
}

/** Capture the subset of a live AcsRoleResponse this app manages, for rollback. */
export function toAcsRoleRollbackPrior(live: AcsRoleResponse): Record<string, unknown> {
  const prior: Record<string, unknown> = {}
  if (live.imported?.roles !== undefined) prior.importedRoles = live.imported.roles
  if (live.capabilities !== undefined) prior.capabilities = live.capabilities
  if (live.srchIndexesAllowed !== undefined) prior.srchIndexesAllowed = live.srchIndexesAllowed
  if (live.srchIndexesDefault !== undefined) prior.srchIndexesDefault = live.srchIndexesDefault
  if (live.srchFilter !== undefined) prior.srchFilter = live.srchFilter
  if (live.srchTimeWin !== undefined) prior.srchTimeWin = live.srchTimeWin
  if (live.srchTimeEarliest !== undefined) prior.srchTimeEarliest = live.srchTimeEarliest
  if (live.defaultApp !== undefined) prior.defaultApp = live.defaultApp
  if (live.srchJobsQuota !== undefined) prior.srchJobsQuota = live.srchJobsQuota
  if (live.rtSrchJobsQuota !== undefined) prior.rtSrchJobsQuota = live.rtSrchJobsQuota
  if (live.srchDiskQuota !== undefined) prior.srchDiskQuota = live.srchDiskQuota
  if (live.cumulativeSrchJobsQuota !== undefined) prior.cumulativeSrchJobsQuota = live.cumulativeSrchJobsQuota
  if (live.cumulativeRTSrchJobsQuota !== undefined) prior.cumulativeRTSrchJobsQuota = live.cumulativeRTSrchJobsQuota
  return prior
}

// --- CRUD, scoped to one (already-targeted) ACS request -----------------------
// Callers pass `acs` already scoped to a target via lib/acsIdentity.ts's
// withTarget() — this module never resolves targets itself, keeping the
// SHC-targeting concern in exactly one place.

export async function getAcsRole(acs: AcsRequestOptions, name: string): Promise<AcsRoleResponse | null> {
  return getAcsIdentityEntity<AcsRoleResponse>(acs, acsRolePath(name))
}

export async function createAcsRole(acs: AcsRequestOptions, spec: RoleSpec): Promise<AcsRoleResponse> {
  const body = { name: spec.name, ...buildAcsRolePayload(spec) }
  return createAcsIdentityEntity<AcsRoleResponse>(
    acs,
    ACS_ROLES_COLLECTION_PATH,
    body,
    FEDERATED_SEARCH_MANAGE_ACK_HEADER,
  )
}

export async function updateAcsRole(
  acs: AcsRequestOptions,
  name: string,
  payload: Record<string, unknown>,
): Promise<AcsRoleResponse | null> {
  // ACS requires at least one field in a PATCH body — a role whose canvas
  // declares nothing new (or a rollback restoring an already-empty prior) is a
  // legitimate no-op, not an error.
  if (Object.keys(payload).length === 0) return null
  return updateAcsIdentityEntity<AcsRoleResponse>(acs, acsRolePath(name), payload, FEDERATED_SEARCH_MANAGE_ACK_HEADER)
}

export async function deleteAcsRole(acs: AcsRequestOptions, name: string): Promise<void> {
  return deleteAcsIdentityEntity(acs, acsRolePath(name))
}
