import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import type { HecRollbackEntry } from './deploy'

const HEC_PATH = '/inputs/http-event-collectors'

/**
 * Roll back HEC token configuration using the state captured during deploy:
 *   - tokens that were created are deleted
 *   - tokens that were updated are patched back to their prior spec
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: HecRollbackEntry[] })?.previousState
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
      const encoded = encodeURIComponent(entry.name)

      if (!entry.existed) {
        // Deploy created this token — remove it. 404 means it never finished
        // provisioning (or was already removed), which is the desired state.
        const res = await acsRequest(acs, 'DELETE', `${HEC_PATH}/${encoded}`)
        if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
          throw new Error(`Failed to delete HEC token "${entry.name}": ${acsErrorMessage(res)}`)
        }
      } else {
        // Deploy updated this token — restore the captured prior spec.
        const patch: Record<string, unknown> = {}
        const prior = entry.prior ?? {}
        if (prior.defaultIndex !== undefined) patch.defaultIndex = prior.defaultIndex
        if (prior.allowedIndexes !== undefined) patch.allowedIndexes = prior.allowedIndexes
        if (prior.defaultSource !== undefined) patch.defaultSource = prior.defaultSource
        if (prior.defaultSourcetype !== undefined) patch.defaultSourcetype = prior.defaultSourcetype
        if (prior.useAck !== undefined) patch.useAck = prior.useAck
        if (prior.disabled !== undefined) patch.disabled = prior.disabled

        if (Object.keys(patch).length > 0) {
          const res = await acsRequest(acs, 'PATCH', `${HEC_PATH}/${encoded}`, patch)
          if (res.status !== 200 && res.status !== 202) {
            throw new Error(`Failed to restore HEC token "${entry.name}": ${acsErrorMessage(res)}`)
          }
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} HEC token(s) on stack "${stack}": ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} HEC token(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
