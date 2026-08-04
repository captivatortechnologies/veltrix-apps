import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildMispUrl, buildAuthHeader, getJson, sendJson } from '../../lib/mispApi'
import { buildUserFields, usersFromList, findUser, normalizeYesNo, type MispUser } from './_shared'

/**
 * Deploy MISP users over the REST API (443):
 *   read (rollback): GET  /admin/users/index         → find the live user by email
 *   create:          POST /admin/users/add             with { User: {..., notify} }
 *   update:          POST /admin/users/edit/<id>        with { User: {...} } (user exists)
 *
 * The email is the stable identity used to upsert — MISP enforces email
 * uniqueness. `notify` is only meaningful on create (it asks MISP to email the
 * new user its own password-reset link — see _shared.ts for why this app never
 * sets a password itself) and is omitted from update bodies. rollbackData
 * records, per user, the prior user body (null when it did not exist) AND the
 * user id — a prior body restores via edit; a newly created user (no prior
 * body) is deleted on rollback via /admin/users/delete/<id>.
 *
 * NOTE: verify /admin/users/index + /admin/users/add + /admin/users/edit/<id> +
 * /admin/users/delete/<id> against a live MISP 2.4 instance.
 */
interface UserMutationResponse {
  User?: MispUser
}

async function listUsers(base: string, headers: Record<string, string>): Promise<MispUser[]> {
  try {
    return usersFromList(await getJson<unknown>(`${base}/admin/users/index`, headers))
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!credential) {
    return { success: false, message: 'Missing credential for user deployment' }
  }

  const base = buildMispUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ email: string; userId: number | string | null; user: MispUser | null }> = []
  const applied: string[] = []

  try {
    const live = await listUsers(base, headers)

    for (const item of items) {
      const email = String(item.fields.email ?? '').trim()
      if (!email) continue

      const existing = findUser(live, email)
      const userFields = buildUserFields(item.fields)

      if (existing && existing.id != null) {
        await sendJson('POST', `${base}/admin/users/edit/${encodeURIComponent(String(existing.id))}`, headers, { User: userFields })
        previous.push({ email, userId: existing.id, user: existing })
      } else {
        const body = { User: { ...userFields, notify: normalizeYesNo(item.fields.notify) } }
        const created = await sendJson<UserMutationResponse>('POST', `${base}/admin/users/add`, headers, body)
        const newId = created?.User?.id ?? null
        previous.push({ email, userId: newId, user: null })
      }
      applied.push(email)
    }

    return {
      success: true,
      message: `Applied ${applied.length} user(s): ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deploy failed after ${applied.length} user(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
