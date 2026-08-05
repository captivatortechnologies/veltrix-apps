import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { appPath, type SplunkbaseRollbackEntry } from './deploy'

/**
 * Roll back a Splunk Cloud Splunkbase-app deploy.
 *
 *   created by this deploy .... DELETE {acs}/{stack}/adminconfig/v2/apps/victoria/{app}
 *                               (Classic: .../apps/{app})
 *   upgraded by this deploy ... REPORTED, NOT REVERTED.
 *
 * Same reasoning as the private-app type: ACS supports upgrading a Splunkbase
 * app to a newer version only, never downgrading, so reverting an upgrade
 * would require uninstall-then-reinstall of the older version — which this
 * handler has no package/version artifact to safely automate, and which would
 * discard any local app-level customization. The upgrade case is surfaced to
 * the operator instead.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      success: false,
      message: 'No ACS token available for rollback — check the credential "API token" field',
    }
  }

  const previousState = (ctx.rollbackData as { previousState?: SplunkbaseRollbackEntry[] })
    ?.previousState
  if (!previousState || previousState.length === 0) {
    return { success: false, message: 'No previous state available for Splunkbase app rollback' }
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
      const experience = entry.experience ?? settings.experience
      const path = appPath(experience, entry.appName)

      if (!entry.existed) {
        const res = await acsRequest(acs, 'DELETE', path)
        if (res.status !== 200 && res.status !== 202 && res.status !== 404) {
          throw new Error(`Failed to uninstall app "${entry.appName}": ${acsErrorMessage(res)}`)
        }
        removed.push(entry.appName)
        continue
      }

      manual.push(
        `"${entry.appName}" was UPGRADED from ${entry.previousVersion ?? 'an unknown version'} to ` +
          `${entry.installedVersion} and is still installed at ${entry.installedVersion}`,
      )
    }

    const parts: string[] = []
    if (removed.length > 0) parts.push(`uninstalled ${removed.length} newly installed app(s): ${removed.join(', ')}`)

    if (manual.length > 0) {
      parts.push(
        `${manual.length} app(s) could NOT be reverted automatically — ${manual.join('; ')}. ` +
          'ACS cannot downgrade a Splunkbase app: reverting requires uninstall-then-reinstall of the older version.',
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
