import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { SELF_STORAGE_BUCKETS_PATH } from './validate'
import type { SelfStorageRollbackEntry } from './deploy'

/**
 * Roll back DDSS self storage registrations created during deploy.
 *
 * IMPORTANT: ACS does not support deleting self storage locations, so this is a
 * best-effort revert. For each location the deploy CREATED (existed === false)
 * it attempts a DELETE; locations that already existed are left untouched.
 * A registered-but-unused self storage location is inert — it only takes effect
 * once an index's `selfStorageBucketPath` points at it — so any location ACS
 * refuses to delete is reported for manual cleanup rather than failing the
 * rollback.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: SelfStorageRollbackEntry[] })
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

  const created = previousState.filter((e) => !e.existed)
  const removed: string[] = []
  const manual: string[] = []

  try {
    for (const entry of created) {
      const identifier = entry.bucketPath ?? entry.bucketName
      const res = await acsRequest(
        acs,
        'DELETE',
        `${SELF_STORAGE_BUCKETS_PATH}/${encodeURIComponent(identifier)}`,
      )
      // 2xx or 404 (already gone) = removed; anything else (typically 405/501 —
      // ACS does not support deleting self storage locations) = manual cleanup.
      if ((res.status >= 200 && res.status < 300) || res.status === 404) {
        removed.push(entry.title)
      } else {
        manual.push(entry.title)
      }
    }

    if (created.length === 0) {
      return {
        success: true,
        message: `Nothing to roll back on stack "${stack}" — all declared self storage locations already existed`,
      }
    }

    const manualNote =
      manual.length > 0
        ? ` — ACS could not delete ${manual.length} location(s) (${manual.join(', ')}); DDSS self storage locations must be removed manually in Splunk Web / via Support`
        : ''
    return {
      success: true,
      message: `Rolled back DDSS self storage on stack "${stack}": removed ${removed.length} of ${created.length} created location(s)${manualNote}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after removing ${removed.length} of ${created.length} location(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
