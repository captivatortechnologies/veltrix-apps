import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildPagerDutyClient,
  pagerDutyErrorMessage,
  parseJson,
  type PagerDutyClient,
} from '../../lib/pagerdutyApi'
import { buildUserBody, extractUserSpecs, type LiveUser } from './_shared'

/** Per-user rollback record captured during deploy. */
export interface UserRollbackEntry {
  email: string
  existed: boolean
  id?: string
  prior?: LiveUser
}

/**
 * Deploy PagerDuty users over the REST API v2:
 *   read (rollback): GET  /users          → find each live user by email
 *   create:          POST /users           with { user: {...} } (sends the user an invitation email)
 *   update:          PUT  /users/{id}       with { user: {...} }
 *
 * The email is the stable identity used to upsert. rollbackData records, per
 * user, whether it existed and its prior body — so rollback can restore an
 * updated user or delete a newly created one.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildPagerDutyClient(ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const specs = extractUserSpecs(ctx.canvas).filter((s) => s.name && s.email)
  const rollbackState: UserRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listUsers(client)
    const byEmail = new Map(existing.filter((u) => u.email).map((u) => [String(u.email).toLowerCase(), u]))

    for (const spec of specs) {
      const body = { user: buildUserBody(spec) }
      const live = byEmail.get(spec.email.toLowerCase())

      if (live && live.id) {
        rollbackState.push({ email: spec.email, existed: true, id: live.id, prior: live })
        const res = await client.request('PUT', `/users/${encodeURIComponent(live.id)}`, { body })
        if (!res.ok) throw new Error(`Failed to update user "${spec.email}": ${pagerDutyErrorMessage(res)}`)
      } else {
        const res = await client.request('POST', '/users', { body })
        if (!res.ok) throw new Error(`Failed to create user "${spec.email}": ${pagerDutyErrorMessage(res)}`)
        const created = parseJson<{ user?: LiveUser }>(res.body)?.user
        if (!created?.id) throw new Error(`User "${spec.email}" was created but the API returned no id`)
        rollbackState.push({ email: spec.email, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(spec.email)
    }

    return {
      success: true,
      message: `Applied ${deployed.length} user(s): ${deployed.join(', ') || '(none)'}`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deploy failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

/** List all users in the account; throws on a non-OK response. */
export async function listUsers(client: PagerDutyClient): Promise<LiveUser[]> {
  const res = await client.getAll<LiveUser>('/users', 'users')
  if (!res.ok) {
    throw new Error(`Failed to list users: ${pagerDutyErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  return res.items
}
