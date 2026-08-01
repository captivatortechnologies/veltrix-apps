import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, sendJson, listUsers, PRIMARY } from '../../lib/thehiveApi'
import {
  buildUserCreateBody,
  buildUserUpdateBody,
  findUser,
  userId,
  usersFromList,
  normalizeLogin,
  type HiveUser,
} from './_shared'

/**
 * Deploy TheHive users over the REST API:
 *   read (rollback): list users                       → find the live one by login
 *   create:          POST   /api/v1/user               with InputUser
 *   update:          PATCH  /api/v1/user/<id>           with InputUpdateUser (no login)
 *
 * The login is the stable identity used to upsert. rollbackData records, per
 * user, the prior user body (null when it did not exist) AND the id — so rollback
 * can restore the prior name/profile/org or delete the one we created. Passwords
 * and API keys are intentionally not managed here (see _shared.ts).
 *
 * v5 paths are primary (see lib/thehiveApi.ts API_VERSION seam). Verify against a
 * live TheHive (see README, v4 vs v5).
 */
async function listAll(base: string, headers: Record<string, string>): Promise<HiveUser[]> {
  try {
    return usersFromList(await listUsers<HiveUser>(base, headers))
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

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  const previous: Array<{ login: string; userIdValue: string | null; user: HiveUser | null }> = []
  const applied: string[] = []

  try {
    const live = await listAll(base, headers)

    for (const item of items) {
      const login = normalizeLogin(item.fields.login)
      if (!login) continue

      const existing = findUser(live, login)
      const existingId = userId(existing)

      if (existing && existingId) {
        await sendJson('PATCH', `${base}${PRIMARY.userById(existingId)}`, headers, buildUserUpdateBody(item.fields))
        previous.push({ login, userIdValue: existingId, user: existing })
      } else {
        const created = await sendJson<HiveUser>('POST', `${base}${PRIMARY.user}`, headers, buildUserCreateBody(item.fields))
        previous.push({ login, userIdValue: userId(created), user: null })
      }
      applied.push(login)
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
