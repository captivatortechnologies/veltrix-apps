import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildRunzeroUrl, buildAuthHeader, resolveRunzeroToken, getJson, sendJson, coerceList, MISSING_CREDENTIAL_MESSAGE } from '../../lib/runzeroApi'
import {
  buildUserOptions,
  buildUserInviteOptions,
  findUser,
  wantsInvite,
  text,
  type RunzeroUser,
  type UserRollbackEntry,
} from './_shared'

/**
 * Deploy runZero Users over the console REST API:
 *   read (identity): GET   /account/users            → find the live user by email
 *   create (invite): PUT   /account/users/invite      with UserInviteOptions (default — emails the user)
 *   create (direct): PUT   /account/users             with UserOptions (Send Email Invite unchecked)
 *   update:          PATCH /account/users/{id}        with UserOptions (user exists)
 *
 * ACCOUNT-scoped: requires an account-scoped runZero API key (see _shared header). The email is the
 * stable identity used to upsert. rollbackData records, per user, whether it already existed, its
 * id, and its prior body — so rollback can restore an update or delete a create.
 *
 * WARNING: rollback of a create DELETEs the user account. See _shared header and the app README.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, connectivityProvider, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []

  if (!resolveRunzeroToken(credential)) {
    return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  }

  const base = buildRunzeroUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const timeoutMs = timeoutFrom(settings)

  const previous: UserRollbackEntry[] = []
  const applied: string[] = []

  try {
    const live = coerceList<RunzeroUser>(await getJson<unknown>(`${base}/account/users`, headers, timeoutMs))

    for (const item of items) {
      const email = text(item.fields.email)
      if (!email) continue

      const existing = findUser(live, email)

      if (existing && existing.id) {
        await sendJson('PATCH', `${base}/account/users/${encodeURIComponent(existing.id)}`, headers, buildUserOptions(item.fields), timeoutMs)
        previous.push({ email, userId: existing.id, existed: true, prior: existing })
      } else if (wantsInvite(item.fields)) {
        const created = await sendJson<RunzeroUser>('PUT', `${base}/account/users/invite`, headers, buildUserInviteOptions(item.fields), timeoutMs)
        previous.push({ email, userId: created?.id ?? null, existed: false, prior: null })
      } else {
        const created = await sendJson<RunzeroUser>('PUT', `${base}/account/users`, headers, buildUserOptions(item.fields), timeoutMs)
        previous.push({ email, userId: created?.id ?? null, existed: false, prior: null })
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

/** Resolve the per-request timeout (ms) from the app setting, defaulting to the client default. */
function timeoutFrom(settings: Record<string, unknown>): number | undefined {
  const raw = settings?.request_timeout_seconds
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw * 1000 : undefined
}
