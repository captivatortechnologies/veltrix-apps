import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { USERS_BASE_PATH, buildRestorePayload, type UserRollbackEntry } from './deploy'

/**
 * Roll back user configuration using the state captured during deploy: every
 * user the deploy updated is posted back to its captured prior roles/attributes
 * (POST /services/authentication/users/<user>).
 *
 * This app never creates users, so rollback never deletes one — it only
 * restores prior values. Runs against the same stack REST API on port 8089 as
 * deploy; the same two prerequisites apply, and failures name them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: `Rollback cannot reach the stack. ${REST_TOKEN_MISSING}` }
  }

  const previousState = (ctx.rollbackData as { previousState?: UserRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for user rollback' }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const reverted: string[] = []

  try {
    for (const entry of previousState) {
      const userPath = `${USERS_BASE_PATH}/${encodeURIComponent(entry.name)}`
      const payload = buildRestorePayload(entry.prior ?? {})
      if (Object.keys(payload).length > 0) {
        await postForm(baseUrl, auth, userPath, payload, timeoutMs)
      }
      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} user(s) on stack "${stack}": restored prior roles/attributes for ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `User rollback failed after ${reverted.length} of ${previousState.length} user(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
