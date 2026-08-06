import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildAkeylessClient, akeylessErrorMessage } from '../../lib/akeyless'
import { buildAuthMethodBody, type AuthMethodRollbackEntry } from './deploy'

/**
 * Roll back auth methods using the state captured during deploy:
 *   - auth methods that were created are deleted (POST /auth-method-delete,
 *     tolerate 404). If Akeyless refuses because Delete Protection is
 *     enabled, that failure is surfaced rather than silently ignored.
 *   - auth methods that were updated have their prior (non-secret) fields
 *     restored via POST /auth-method-update-{type}. A write-only secret
 *     (OIDC client secret) rotated by the deploy being rolled back CANNOT be
 *     restored - Akeyless never returns it, so this app never captured it.
 *
 * Never touches an auth method this deploy did not create or change.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildAkeylessClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const previousState = (ctx.rollbackData as { previousState?: AuthMethodRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const reverted: string[] = []
  const warnings: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        const res = await client.request('/auth-method-delete', { name: entry.name })
        if (res.status !== 404 && !res.ok) {
          throw new Error(`Failed to delete auth method "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
      } else if (entry.priorSpec) {
        const res = await client.request(
          `/auth-method-update-${entry.priorSpec.type}`,
          buildAuthMethodBody(entry.priorSpec, { isUpdate: true }),
        )
        if (!res.ok) {
          throw new Error(`Failed to restore auth method "${entry.name}": ${akeylessErrorMessage(res)}`)
        }
        if (entry.priorSpec.type === 'oidc') {
          warnings.push(`"${entry.name}": its OIDC Client Secret (write-only) could not be restored by rollback.`)
        }
      }

      reverted.push(entry.name)
    }

    const message = `Rolled back ${reverted.length} auth method(s): ${reverted.join(', ')}.${
      warnings.length ? ' ' + warnings.join(' ') : ''
    }`
    return { success: true, message }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} item(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
