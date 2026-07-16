import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import type { LimitRollbackEntry } from './deploy'

/**
 * Roll back limits.conf changes by restoring the prior values captured during
 * deploy: each setting is POSTed back to its previousValue. Settings whose prior
 * value was unreadable at deploy time are skipped (there is nothing to restore).
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: LimitRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for rollback' }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const reverted: string[] = []
  const skipped: string[] = []

  try {
    for (const entry of previousState) {
      const label = `${entry.stanza}.${entry.setting}`

      // No captured prior value — nothing safe to restore.
      if (entry.previousValue === null) {
        skipped.push(label)
        continue
      }

      // Already at the prior value (deploy was a no-op for this setting).
      if (entry.previousValue === String(entry.newValue)) {
        reverted.push(label)
        continue
      }

      const priorNumber = Number(entry.previousValue)
      if (!Number.isFinite(priorNumber)) {
        skipped.push(label)
        continue
      }

      const res = await acsRequest(acs, 'POST', `/limits/${encodeURIComponent(entry.stanza)}`, {
        settings: { [entry.setting]: priorNumber },
      })
      if (res.status !== 200 && res.status !== 202) {
        throw new Error(`Failed to restore ${label}: ${acsErrorMessage(res)}`)
      }
      reverted.push(label)
    }

    const skipSuffix = skipped.length > 0 ? ` (skipped ${skipped.length} without a captured prior value: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Rolled back ${reverted.length} limits.conf setting(s) on stack "${stack}": ${reverted.join(', ')}${skipSuffix}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} setting(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
