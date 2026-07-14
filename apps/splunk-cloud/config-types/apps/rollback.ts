import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPath, type AppRollbackEntry } from './deploy'

/**
 * Roll back a Splunk Cloud private-app deploy.
 *
 *   created by this deploy .... DELETE {acs}/{stack}/adminconfig/v2/apps/victoria/{app}
 *                               (Classic: .../apps/{app})
 *   upgraded by this deploy ... REPORTED, NOT REVERTED.
 *
 * ACS has no downgrade: installing an OLDER version over a newer one is refused,
 * so going back means UNINSTALL-then-INSTALL. Uninstalling destroys the app's
 * `local/` directory — every setting a user changed in Splunk Web, every
 * generated credential — and this handler no longer holds the previous package
 * to reinstall. Silently deleting a pre-existing app to "roll back" would
 * therefore destroy data the deploy never created, so the upgrade case is
 * surfaced to the operator instead of being automated.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: AppRollbackEntry[] })?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for Splunk Cloud app rollback' }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const removed: string[] = []
  const manual: string[] = []

  try {
    for (const entry of previousState) {
      // The entry records the experience the app was installed under; fall back
      // to the current setting for a rollback of an older deploy record.
      const experience = entry.experience ?? settings.experience
      const path = appPath(experience, entry.appId)

      if (!entry.existed) {
        // This deploy created the app — uninstalling restores the prior state
        // exactly. A 404 means the install never completed, which is the goal.
        const res = await acsRequest(acs, 'DELETE', path)
        if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
          throw new Error(`Failed to uninstall app "${entry.appId}": ${acsErrorMessage(res)}`)
        }
        removed.push(entry.appId)
        continue
      }

      manual.push(
        `"${entry.appId}" was UPGRADED from ${entry.previousVersion ?? 'an unknown version'} to ` +
          `${entry.installedVersion} and is still installed at ${entry.installedVersion}`,
      )
    }

    const parts: string[] = []
    if (removed.length > 0) parts.push(`uninstalled ${removed.length} newly installed app(s): ${removed.join(', ')}`)

    if (manual.length > 0) {
      parts.push(
        `${manual.length} app(s) could NOT be reverted automatically — ${manual.join('; ')}. ` +
          'ACS cannot downgrade an app in place: reverting requires uninstall-then-install of the older package. ' +
          'WARNING: uninstalling an app DESTROYS its local/ directory (every setting changed in Splunk Web, ' +
          'every generated credential) — back that up before you do it.',
      )
    }

    return {
      success: true,
      message: `Rollback on stack "${stack}": ${parts.join('. ') || 'no changes'}`,
    }
  } catch (error) {
    return {
      success: false,
      message: `Rollback failed after ${removed.length} of ${previousState.length} app(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
    }
  }
}
