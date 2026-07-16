import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { PREFERENCES_PATH } from './validate'
import type { ChangeFreezePreferences, MaintenanceWindowRollbackState } from './deploy'

/**
 * Roll back a change-freeze deployment by restoring the customer-initiated
 * freeze list captured before deploy.
 *
 * The maintenance-window preference uses optimistic concurrency (recordVersion),
 * which the deploy PUT incremented — so rollback re-reads the CURRENT
 * recordVersion and PUTs the prior freeze list against it.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: MaintenanceWindowRollbackState })
    ?.previousState
  if (!previousState) {
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

  try {
    // recordVersion moved on since deploy — read the current one to satisfy
    // optimistic concurrency, then restore the prior customer-initiated freezes.
    const currentRes = await acsRequest(acs, 'GET', PREFERENCES_PATH)
    if (currentRes.status !== 200) {
      throw new Error(`Failed to read current preferences: ${acsErrorMessage(currentRes)}`)
    }
    const current = parseJson<ChangeFreezePreferences>(currentRes.body) ?? {}
    const recordVersion = current.recordVersion ?? previousState.recordVersion

    const res = await acsRequest(acs, 'PUT', PREFERENCES_PATH, {
      changeFreezes: { customerInitiatedFreezes: previousState.customerInitiatedFreezes },
      recordVersion,
    })
    if (res.status !== 200 && res.status !== 202 && res.status !== 204) {
      throw new Error(`Failed to restore change-freeze preferences: ${acsErrorMessage(res)}`)
    }

    return {
      success: true,
      message: `Restored ${previousState.customerInitiatedFreezes.length} customer-initiated change freeze(s) on stack "${stack}"`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Change freeze rollback on stack "${stack}" failed: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
