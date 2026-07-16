import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPermissionsPath } from './validate'
import type { AppPermissionRollbackEntry } from './deploy'

/**
 * Roll back app-permission changes by restoring the read/write role arrays
 * captured before deploy. Because a permissions PATCH fully replaces an app's
 * assignment, restoring is a single PATCH per app with the previous read[]/write[].
 * Apps that had no prior permissions record are skipped — there is nothing to
 * restore them to.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: AppPermissionRollbackEntry[] })
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
  const skipped: string[] = []

  try {
    for (const entry of previousState) {
      if (!entry.existed) {
        skipped.push(entry.appName)
        continue
      }

      const res = await acsRequest(acs, 'PATCH', appPermissionsPath(entry.appName), {
        read: entry.previousRead,
        write: entry.previousWrite,
      })
      if (res.status !== 200 && res.status !== 202) {
        throw new Error(`Failed to restore permissions for app "${entry.appName}": ${acsErrorMessage(res)}`)
      }

      reverted.push(entry.appName)
    }

    const skippedNote =
      skipped.length > 0 ? ` (${skipped.length} had no prior permissions: ${skipped.join(', ')})` : ''
    return {
      success: true,
      message: `Restored permissions for ${reverted.length} app(s) on stack "${stack}": ${reverted.join(', ')}${skippedNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${reverted.length} of ${previousState.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
