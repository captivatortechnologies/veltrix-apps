// Network helpers for the enabled-connections sub-resource of the Auth0
// Organizations config type. Kept out of _shared.ts so _shared stays pure and
// unit-testable; these wrap lib/auth0Api against
// /api/v2/organizations/{id}/enabled_connections.
//
//   GET    /organizations/{id}/enabled_connections                 list current
//   POST   /organizations/{id}/enabled_connections                 add one
//   PATCH  /organizations/{id}/enabled_connections/{connectionId}  update flags
//   DELETE /organizations/{id}/enabled_connections/{connectionId}  remove
//
// Verified against the official Auth0 Management API v2 (Organizations →
// enabled connections):
//   https://auth0.com/docs/api/management/v2/organizations/post-enabled-connections-to-organization
//   https://auth0.com/docs/api/management/v2/organizations/patch-enabled-connections-by-connection-id

import { deleteResource, listAllPages, sendJson } from '../../lib/auth0Api'
import { sameEnabledConnection, type EnabledConnectionSpec } from './_shared'

interface LiveEnabledConnection {
  connection_id?: string
  assign_membership_on_login?: boolean
  is_signup_enabled?: boolean
  show_as_button?: boolean
}

function toSpec(live: LiveEnabledConnection): EnabledConnectionSpec {
  return {
    connectionId: String(live.connection_id ?? '').trim(),
    assignMembershipOnLogin: live.assign_membership_on_login === true,
    isSignupEnabled: live.is_signup_enabled === true,
    showAsButton: live.show_as_button === true,
  }
}

function toBody(spec: EnabledConnectionSpec) {
  return {
    assign_membership_on_login: spec.assignMembershipOnLogin,
    is_signup_enabled: spec.isSignupEnabled,
    show_as_button: spec.showAsButton,
  }
}

/** Read every connection currently enabled on an organization (paginated, best-effort). */
export async function getEnabledConnections(base: string, orgId: string, token: string): Promise<EnabledConnectionSpec[]> {
  const live = await listAllPages<LiveEnabledConnection>(
    (page) => `${base}/organizations/${encodeURIComponent(orgId)}/enabled_connections?per_page=100&page=${page}`,
    token,
  )
  return live.map(toSpec).filter((spec) => spec.connectionId)
}

/**
 * Reconcile an organization's live enabled connections to `desired`: read
 * current, add the missing ones, update the ones whose flags changed, and
 * remove the ones no longer declared. Returns the counts applied.
 */
export async function reconcileEnabledConnections(
  base: string,
  orgId: string,
  token: string,
  desired: EnabledConnectionSpec[],
): Promise<{ added: number; updated: number; removed: number }> {
  const current = await getEnabledConnections(base, orgId, token)
  const currentById = new Map(current.map((c) => [c.connectionId, c]))
  const desiredIds = new Set(desired.map((d) => d.connectionId))
  const orgPath = `${base}/organizations/${encodeURIComponent(orgId)}/enabled_connections`

  let added = 0
  let updated = 0
  let removed = 0

  for (const spec of desired) {
    const existing = currentById.get(spec.connectionId)
    if (!existing) {
      await sendJson('POST', orgPath, token, { connection_id: spec.connectionId, ...toBody(spec) })
      added++
    } else if (!sameEnabledConnection(existing, spec)) {
      await sendJson('PATCH', `${orgPath}/${encodeURIComponent(spec.connectionId)}`, token, toBody(spec))
      updated++
    }
  }

  for (const existing of current) {
    if (!desiredIds.has(existing.connectionId)) {
      await deleteResource(`${orgPath}/${encodeURIComponent(existing.connectionId)}`, token)
      removed++
    }
  }

  return { added, updated, removed }
}
