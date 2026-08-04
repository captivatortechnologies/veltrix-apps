import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSecretServerClient, secretServerErrorMessage } from '../../lib/secretServerApi'
import { extractUserSpecs, searchUsers, findUserByUsername, buildUserUpdateBody, isDirectoryUser, userIdOf, type LiveUser } from './_shared'

/**
 * One user's prior state, captured for rollback. `skipped` marks a
 * directory-managed user this deploy did not touch.
 */
export interface UserRollbackEntry {
  username: string
  userId: number | null
  skipped: boolean
  prior: LiveUser | null
}

/**
 * Deploy Secret Server user profile attributes over the REST API
 * (/api/v1/users) — EXISTING users only, never creating one and never
 * sending a password (see _shared.ts):
 *   read:   GET /users?filter.searchText=<username>  → match exact username
 *   update: PUT /users/{id}                            with the FULL merged user object
 *
 * A user that does not exist is a hard failure with a clear message. A user
 * backed by Active Directory is skipped (its profile belongs to the
 * directory), matching the pattern already established for a synchronized
 * Group. rollbackData records, per user, the prior FULL object so rollback
 * can PUT it back verbatim.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildSecretServerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client, apiBase } = built

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const specs = extractUserSpecs(items).filter((s) => s.username)

  const previous: UserRollbackEntry[] = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    for (const spec of specs) {
      const matches = await searchUsers(client, spec.username)
      const existing = findUserByUsername(matches, spec.username)

      if (!existing) {
        throw new Error(
          `User "${spec.username}" does not exist in Secret Server. This app manages profile attributes for ` +
            'EXISTING users only — creating a local user requires setting a password, which is intentionally out ' +
            'of scope for a PAM configuration-as-code tool (passwords are never stored as canvas config). Create ' +
            'the user in Secret Server, or sync it from Active Directory, then deploy to manage its profile.',
        )
      }

      if (isDirectoryUser(existing)) {
        skipped.push(spec.username)
        continue
      }

      const userId = userIdOf(existing)
      if (userId === null) throw new Error(`User "${spec.username}" exists but has no usable id`)

      const res = await client.request('PUT', `/users/${userId}`, { body: buildUserUpdateBody(spec, existing) })
      if (!res.ok) throw new Error(`Failed to update user "${spec.username}": ${secretServerErrorMessage(res)}`)

      previous.push({ username: spec.username, userId, skipped: false, prior: existing })
      applied.push(spec.username)
    }

    const skippedNote = skipped.length ? ` (${skipped.length} directory-managed user(s) skipped: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Reconciled ${applied.length} user(s) at ${apiBase}: ${applied.join(', ') || '(none)'}${skippedNote}`,
      artifacts: { apiBase, applied, skipped },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `User deploy failed after ${applied.length} of ${specs.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { apiBase, applied, skipped },
      rollbackData: { previous },
    }
  }
}
