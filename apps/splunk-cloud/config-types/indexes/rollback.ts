import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import type { IndexRollbackEntry } from './deploy'

/**
 * Roll back index configuration using the state captured during deploy:
 *   - indexes that were created are deleted (DELETE /adminconfig/v2/indexes/{name})
 *   - indexes that were updated are patched back to their prior values
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: IndexRollbackEntry[] })?.previousState
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
        // Deploy created this index — remove it. 404 means it never finished
        // provisioning (or was already removed), which is the desired state.
        const res = await acsRequest(acs, 'DELETE', `/indexes/${encoded}`)
        if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
          throw new Error(`Failed to delete index "${entry.name}": ${acsErrorMessage(res)}`)
        }
      } else {
        // Deploy updated this index — restore the captured prior values.
        const patch: Record<string, unknown> = {}
        if (entry.prior?.searchableDays !== undefined) patch.searchableDays = entry.prior.searchableDays
        if (entry.prior?.maxDataSizeMB !== undefined) patch.maxDataSizeMB = entry.prior.maxDataSizeMB
        if (entry.prior?.splunkArchivalRetentionDays !== undefined) {
          patch.splunkArchivalRetentionDays = entry.prior.splunkArchivalRetentionDays
        }
        if (entry.prior?.selfStorageBucketPath !== undefined) {
          patch.selfStorageBucketPath = entry.prior.selfStorageBucketPath
        }

        if (Object.keys(patch).length > 0) {
          const res = await acsRequest(acs, 'PATCH', `/indexes/${encoded}`, patch)
          if (res.status !== 200 && res.status !== 202) {
            throw new Error(`Failed to restore index "${entry.name}": ${acsErrorMessage(res)}`)
          }
        }
      }

      reverted.push(entry.name)
    }

    return {
      success: true,
      message: `Rolled back ${reverted.length} index(es) on stack "${stack}": ${reverted.join(', ')}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} index(es): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
