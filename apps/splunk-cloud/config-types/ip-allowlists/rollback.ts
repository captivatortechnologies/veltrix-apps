import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import type { AllowlistRollbackEntry } from './deploy'

/**
 * Roll back IP allow list changes using the delta captured during deploy:
 *   - subnets the deployment added are removed
 *   - subnets the deployment removed are restored
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: AllowlistRollbackEntry[] })
    ?.previousState
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

  try {
    for (const entry of previousState) {
      const path = `/access/${encodeURIComponent(entry.feature)}/ipallowlists`

      if (entry.added.length > 0) {
        const res = await acsRequest(acs, 'DELETE', path, { subnets: entry.added })
        if (res.status !== 200 && res.status !== 202) {
          throw new Error(
            `Failed to remove added subnets from "${entry.feature}": ${acsErrorMessage(res)}`,
          )
        }
      }

      if (entry.removed.length > 0) {
        const res = await acsRequest(acs, 'POST', path, { subnets: entry.removed })
        if (res.status !== 200 && res.status !== 201 && res.status !== 202) {
          throw new Error(
            `Failed to restore removed subnets to "${entry.feature}": ${acsErrorMessage(res)}`,
          )
        }
      }

      reverted.push(entry.feature)
    }

    return {
      success: true,
      message: `Rolled back allow list changes for ${reverted.length} feature(s) on stack "${stack}": ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} feature(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
