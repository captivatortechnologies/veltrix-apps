import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import {
  acsErrorMessage,
  acsRequest,
  parseJson,
  readAcsSettings,
  resolveAcsToken,
  resolveStackName,
  type AcsRequestOptions,
} from '../../lib/acs'
import { extractMaintenanceWindowSpec, PREFERENCES_PATH, SCHEDULES_PATH } from './validate'
import type { ChangeFreezePreferences } from './deploy'

/**
 * Health check for the maintenance-window change freeze:
 *   1. Change-freeze preferences are readable via ACS (also proves token validity)
 *   2. The declared change freeze exists in the live customer-initiated list
 *   3. Maintenance window schedules are readable (Splunk-managed, view-only)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const token = resolveAcsToken(ctx.credential)
  if (!token) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_token',
          passed: false,
          message: 'No ACS token — store the Splunk Cloud JWT in the credential "API token" field',
        },
      ],
    }
  }

  const settings = readAcsSettings(ctx.settings)
  const stack = resolveStackName(ctx.component.hostname)
  const acs: AcsRequestOptions = {
    baseUrl: settings.baseUrl,
    stack,
    token,
    timeoutMs: settings.timeoutMs,
  }

  const spec = extractMaintenanceWindowSpec(ctx.canvas)
  const checks: HealthCheckResult['checks'] = []

  // 1. Preferences readable (also proves the token works)
  const prefsRes = await acsRequest(acs, 'GET', PREFERENCES_PATH)
  if (prefsRes.status !== 200) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_reachable',
          passed: false,
          message: `Could not read change-freeze preferences via ACS: ${acsErrorMessage(prefsRes)}`,
        },
      ],
    }
  }
  checks.push({ name: 'acs_reachable', passed: true, message: `ACS reachable for stack "${stack}"` })

  // 2. Declared change freeze present in the live customer-initiated list
  const prefs = parseJson<ChangeFreezePreferences>(prefsRes.body) ?? {}
  const live = prefs.changeFreezes?.customerInitiatedFreezes ?? []
  const match = live.find((f) => f.startDate === spec.startDate && f.endDate === spec.endDate)
  checks.push({
    name: 'change_freeze_present',
    passed: !!match,
    message: match
      ? `Change freeze ${spec.startDate}–${spec.endDate} present (appliesTo: ${match.appliesTo})`
      : `Declared change freeze ${spec.startDate}–${spec.endDate} not found on the stack`,
  })

  // 3. Maintenance window schedules readable (customers view Splunk-managed windows)
  const schedRes = await acsRequest(acs, 'GET', SCHEDULES_PATH)
  checks.push({
    name: 'maintenance_windows_readable',
    passed: schedRes.status === 200,
    message:
      schedRes.status === 200
        ? 'Maintenance window schedules are readable'
        : `Could not read maintenance window schedules: ${acsErrorMessage(schedRes)}`,
  })

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 100
  return { healthy: score >= 80, score, checks }
}
