// Network helpers for the Auth0 Actions config type. Kept out of _shared.ts so
// _shared stays pure and unit-testable.
//
// GET /actions/actions returns a WRAPPED page ({ actions, total, page, per_page }),
// unlike every other list endpoint in this app (clients/connections/roles/
// resource-servers all return a raw array) — so it needs its own pagination
// loop rather than lib/auth0Api's `listAllPages` (which assumes a raw array).
//
// Verified against the official Auth0 Management API v2 (Actions):
//   https://auth0.com/docs/api/management/v2/actions/get-actions
//   https://auth0.com/docs/api/management/v2/actions/deploy-action
//   https://auth0.com/docs/api/management/v2/actions/get-bindings
//   https://auth0.com/docs/api/management/v2/actions/patch-bindings

import { getJson, sendJson } from '../../lib/auth0Api'
import { liveBindingsToEntries, type Auth0Action, type BindingEntry, type LiveBinding } from './_shared'

interface ActionsPage {
  actions?: Auth0Action[]
  total?: number
}

/** Read every action (paginated, best-effort) for name matching + rollback. */
export async function listActions(base: string, token: string): Promise<Auth0Action[]> {
  const perPage = 100
  const all: Auth0Action[] = []
  for (let page = 0; page < 50; page++) {
    const batch = await getJson<ActionsPage>(`${base}/actions/actions?per_page=${perPage}&page=${page}`, token)
    const items = batch.actions ?? []
    if (items.length === 0) break
    all.push(...items)
    if (items.length < perPage) break
  }
  return all
}

/** Publish an action's latest (draft) version so it becomes the one that executes. */
export async function deployAction(base: string, actionId: string, token: string): Promise<void> {
  await sendJson('POST', `${base}/actions/actions/${encodeURIComponent(actionId)}/deploy`, token, {})
}

/** Read a trigger's current ordered bindings, projected to the PATCH-body shape. */
export async function getTriggerBindings(base: string, triggerId: string, token: string): Promise<BindingEntry[]> {
  const res = await getJson<{ bindings?: LiveBinding[] }>(`${base}/actions/triggers/${encodeURIComponent(triggerId)}/bindings`, token)
  return liveBindingsToEntries(res.bindings ?? [])
}

/** Replace a trigger's entire ordered bindings list. */
export async function setTriggerBindings(base: string, triggerId: string, token: string, bindings: BindingEntry[]): Promise<void> {
  await sendJson('PATCH', `${base}/actions/triggers/${encodeURIComponent(triggerId)}/bindings`, token, { bindings })
}
