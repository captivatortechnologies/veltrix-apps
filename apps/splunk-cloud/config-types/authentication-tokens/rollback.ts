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
import { TOKEN_AUTH_SETTINGS_PATH, type TokenSettingsRollback } from './deploy'

/**
 * Roll back token-authentication settings by restoring the prior values captured
 * during deploy (POST /services/admin/token-auth/tokens_auth with the previous
 * `disabled` / `expiration`).
 *
 * Runs against the same stack REST API on port 8089 as deploy — the same two
 * prerequisites apply, and failures name them.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveRestToken(ctx.credential)
  if (!token) {
    return { success: false, message: `Rollback cannot reach the stack. ${REST_TOKEN_MISSING}` }
  }

  const previousState = (ctx.rollbackData as { previousState?: TokenSettingsRollback })
    ?.previousState
  if (!previousState) {
    return { success: false, message: 'No previous state available for token-settings rollback' }
  }

  // The settings entity was not readable before deploy — there is nothing to
  // restore. Token-auth settings cannot be deleted (the entity always exists),
  // so a missing prior state means the deploy never applied anything.
  if (!previousState.existed || !previousState.prior) {
    return {
      success: true,
      message: 'No prior token-authentication settings were captured — nothing to roll back',
    }
  }

  const { timeoutMs } = readRestSettings(ctx.settings)
  const stack = resolveStackHost(ctx.component.hostname)
  const baseUrl = buildRestUrl(ctx.component)
  const auth = buildAuthHeader(token)

  const payload: Record<string, string | number | boolean | string[] | undefined | null> = {}
  if (previousState.prior.disabled !== undefined) payload.disabled = previousState.prior.disabled
  if (previousState.prior.expiration !== undefined) payload.expiration = previousState.prior.expiration

  if (Object.keys(payload).length === 0) {
    return { success: true, message: 'No prior token-authentication values to restore' }
  }

  try {
    await postForm(baseUrl, auth, TOKEN_AUTH_SETTINGS_PATH, payload, timeoutMs)
    const restored: string[] = []
    if (payload.disabled !== undefined) {
      restored.push(`token auth ${payload.disabled === 'true' ? 'disabled' : 'enabled'}`)
    }
    if (payload.expiration !== undefined) restored.push(`default expiration ${payload.expiration}`)

    return {
      success: true,
      message: `Rolled back token-authentication settings on stack "${stack}" (${restored.join(', ')})`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Token-authentication settings rollback on stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
