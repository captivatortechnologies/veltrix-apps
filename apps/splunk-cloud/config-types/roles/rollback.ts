import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  REST_TOKEN_MISSING,
  buildAuthHeader,
  buildRestUrl,
  deleteEntity,
  postForm,
  readRestSettings,
  resolveRestToken,
  resolveStackHost,
} from '../../lib/splunkRest'
import { ROLES_BASE_PATH, buildRestorePayload, type RoleRollbackEntry } from './deploy'

/**
 * Roll back role configuration using the state captured during deploy:
 *   - roles the deploy created are deleted (DELETE /services/authorization/roles/<role>)
 *   - roles the deploy updated are posted back to their captured prior values
 *
 * Runs against the same stack REST API on port 8089 as deploy — the same two
 * prerequisites apply, and failures name them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: `Rollback cannot reach the stack. ${REST_TOKEN_MISSING}` }
  }

  const previousState = (ctx.rollbackData as { previousState?: RoleRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for role rollback' }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const reverted: string[] = []
  const deleted: string[] = []

  try {
    for (const entry of previousState) {
      const rolePath = `${ROLES_BASE_PATH}/${encodeURIComponent(entry.name)}`

      if (!entry.existed) {
        // Deploy created this role — remove it.
        await deleteEntity(baseUrl, auth, rolePath, timeoutMs)
        deleted.push(entry.name)
      } else {
        const payload = buildRestorePayload(entry.prior ?? {})
        if (Object.keys(payload).length > 0) {
          await postForm(baseUrl, auth, rolePath, payload, timeoutMs)
        }
      }

      reverted.push(entry.name)
    }

    const actions: string[] = []
    const restored = reverted.length - deleted.length
    if (restored > 0) actions.push(`restored ${restored} role(s)`)
    if (deleted.length > 0) actions.push(`deleted ${deleted.length} created role(s)`)

    return {
      success: true,
      message: `Rolled back ${reverted.length} role(s) on stack "${stack}": ${actions.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Role rollback failed after ${reverted.length} of ${previousState.length} role(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
