import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildBaseUrl, buildAuthHeader, hasBasicAuth, getJson, sendJson } from '../../lib/sumoLogicApi'
import { buildUserCreateBody, buildUserUpdateBody, normalizeActive, usersFromList, type SumoUser } from './_shared'

/**
 * Deploy Sumo Logic users over the Management API (HTTPS):
 *   find (upsert/rollback): GET  /users?email=<email>&limit=1   → { data: [...] } (direct filter, not a full-org list)
 *   create:                 POST /users                          with { firstName, lastName, email, roleIds } — isActive is NOT settable on create
 *   update:                 PUT  /users/<id>                      with { firstName, lastName, isActive, roleIds } (no email — immutable)
 *
 * The user's EMAIL is the stable identity used to upsert. Because `isActive`
 * cannot be set on create, a newly created user who should start deactivated
 * gets an immediate follow-up PUT. rollbackData records, per user, the prior
 * body (null when they did not exist) AND the user id — so rollback can
 * restore the prior body or delete the one we created.
 *
 * API: https://help.sumologic.com/docs/api/user-management/
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!hasBasicAuth(credential)) {
    return { success: false, message: 'Missing Access ID / Access Key credential for user deployment' }
  }

  const base = buildBaseUrl(component, connectivity)
  const headers = buildAuthHeader(credential!)

  const previous: Array<{ email: string; userId: string | null; user: SumoUser | null }> = []
  const applied: string[] = []

  try {
    for (const item of items) {
      const email = String(item.fields.email ?? '').trim()
      if (!email) continue

      let existing: SumoUser | null = null
      try {
        const found = usersFromList(await getJson<unknown>(`${base}/users?email=${encodeURIComponent(email)}&limit=1`, headers))
        existing = found[0] ?? null
      } catch {
        existing = null
      }

      if (existing && existing.id != null) {
        await sendJson('PUT', `${base}/users/${encodeURIComponent(String(existing.id))}`, headers, buildUserUpdateBody(item.fields))
        previous.push({ email, userId: String(existing.id), user: existing })
      } else {
        const created = await sendJson<SumoUser>('POST', `${base}/users`, headers, buildUserCreateBody(item.fields))
        const desiredActive = normalizeActive(item.fields.isActive)
        if (created?.id != null && !desiredActive) {
          await sendJson('PUT', `${base}/users/${encodeURIComponent(String(created.id))}`, headers, buildUserUpdateBody(item.fields))
        }
        previous.push({ email, userId: created?.id != null ? String(created.id) : null, user: null })
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
