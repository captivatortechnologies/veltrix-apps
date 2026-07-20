import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { buildOktaClient, oktaErrorMessage } from '../../lib/okta'
import { type CaptchaRollbackData } from './deploy'

/**
 * Roll back the CAPTCHA configuration using the state captured during deploy.
 * ORDER MATTERS — Okta refuses to delete an instance the org-wide setting still
 * references:
 *   1. Restore the prior org-wide settings (PUT /org/captcha). This also detaches
 *      any instance this deploy created.
 *   2. If the instance was CREATED by this deploy, delete it (DELETE /captchas/{id}).
 *      If it already existed, restore its prior body via PUT — but the write-only
 *      secretKey can NOT be restored (Okta never returned it), so it is left as set.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const built = buildOktaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client } = built

  const data = ctx.rollbackData as CaptchaRollbackData | undefined
  if (!data) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const notes: string[] = []

  try {
    // 1. Restore prior org-wide settings (detaches a created instance).
    if (data.priorOrg) {
      const res = await client.request('PUT', '/org/captcha', {
        body: { captchaId: data.priorOrg.captchaId, enabledPages: data.priorOrg.enabledPages },
      })
      if (!res.ok) {
        throw new Error(`Failed to restore org-wide CAPTCHA settings: ${oktaErrorMessage(res)}`)
      }
      notes.push('restored org-wide settings')
    }

    // 2. Delete a created instance, or restore an updated one.
    if (data.instanceId) {
      if (!data.instanceExisted) {
        const del = await client.request('DELETE', `/captchas/${data.instanceId}`)
        if (!del.ok && del.status !== 404) {
          throw new Error(
            `Failed to delete CAPTCHA instance ${data.instanceId}: ${oktaErrorMessage(del)}. Okta will not delete a CAPTCHA still referenced by the org-wide settings — ensure it is detached first.`,
          )
        }
        notes.push('deleted the created instance')
      } else if (data.priorInstance) {
        const res = await client.request('PUT', `/captchas/${data.instanceId}`, { body: data.priorInstance })
        if (!res.ok) {
          throw new Error(`Failed to restore CAPTCHA instance ${data.instanceId}: ${oktaErrorMessage(res)}`)
        }
        notes.push('restored the prior instance (secret key left unchanged — it is write-only)')
      }
    }

    return {
      success: true,
      message: `Rolled back CAPTCHA configuration: ${notes.join('; ') || 'nothing to revert'}.`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${notes.length} step(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
