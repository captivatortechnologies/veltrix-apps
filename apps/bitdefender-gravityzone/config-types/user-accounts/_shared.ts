// =============================================================================
// Shared helpers for the GravityZone User Accounts config type.
//
// Accounts are reconciled by EMAIL (GravityZone assigns the accountId on
// create). Password is write-only — GravityZone never returns a stored
// password, so drift/rollback cannot compare or restore it; see canvas.yaml
// and README.md "Known limitations".
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, parseJsonObject, readOptionalNumber, sameSet, splitList, str, listAllPaged } from '../../lib/gravityZoneCommon'
import { getAccountDetails, getAccountsList, type GzAccount } from '../../lib/gravityZoneApi'
import type { GravityZoneClient } from '../../lib/gravityZone'

export interface UserAccountSpec {
  itemName: string
  email: string
  fullName: string
  role: number
  timezone: string
  language: string
  password: string
  targetIds: string[]
  rightsRaw: string
}

/** The account's logical identity: its email, trimmed and lower-cased for matching. */
export function userAccountKey(email: string): string {
  return email.trim().toLowerCase()
}

export function extractUserAccountSpecs(canvas: CanvasSnapshot): UserAccountSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      email: str(fields.email),
      fullName: str(fields.fullName),
      role: readOptionalNumber(fields.role) ?? 0,
      timezone: str(fields.timezone),
      language: str(fields.language),
      password: str(fields.password),
      targetIds: splitList(fields.targetIds),
      rightsRaw: str(fields.rights),
    }
  })
}

/** Parse the declared Rights JSON object (only meaningful for role 5 / Custom). */
export function parseRights(spec: UserAccountSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.rightsRaw, `Account "${spec.email}" Rights`)
}

export function accountEmail(account: GzAccount): string {
  return typeof account.email === 'string' ? account.email : ''
}

export function accountId(account: GzAccount): string {
  const id = account.id ?? account.accountId
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

/** Fetch every account across every page (see lib/gravityZoneCommon.ts listAllPaged). */
export async function listAllAccounts(client: GravityZoneClient): Promise<GzAccount[]> {
  return listAllPaged((page, perPage) => getAccountsList(client, { page, perPage }))
}

/**
 * Resolve an account's Rights object for comparison. getAccountsList's list
 * items were not independently confirmed to include the full `rights`
 * object (list endpoints commonly omit heavier nested objects — the same
 * reasoning Sophos Central's GitHub connector `client_secret` distinction
 * documents), so this falls back to accounts.getAccountDetails when the
 * listed item doesn't already carry one.
 */
export async function resolveAccountRights(client: GravityZoneClient, live: GzAccount): Promise<Record<string, unknown> | null> {
  if (live.rights && typeof live.rights === 'object') return live.rights as Record<string, unknown>
  const id = accountId(live)
  if (!id) return null
  const details = await getAccountDetails(client, id)
  const rights = details?.rights
  return rights && typeof rights === 'object' ? (rights as Record<string, unknown>) : null
}

/** Do the live account's comparable (non-write-only) fields already match the declared spec? */
export function accountFieldsMatch(spec: UserAccountSpec, live: GzAccount, liveRights: Record<string, unknown> | null): boolean {
  const liveFullName = live.profile?.fullName ?? live.fullName ?? ''
  const liveTimezone = live.profile?.timezone ?? ''
  const liveLanguage = live.profile?.language ?? ''
  const liveRole = typeof live.role === 'number' ? live.role : undefined
  const liveTargetIds = Array.isArray(live.targetIds) ? live.targetIds.map(String) : []
  const { value: declaredRights } = parseRights(spec)

  return (
    liveFullName === spec.fullName &&
    (!spec.timezone || liveTimezone === spec.timezone) &&
    (!spec.language || liveLanguage === spec.language) &&
    (spec.role === 0 || liveRole === spec.role) &&
    sameSet(spec.targetIds, liveTargetIds) &&
    canonicalJson(declaredRights ?? {}) === canonicalJson(liveRights ?? {})
  )
}
