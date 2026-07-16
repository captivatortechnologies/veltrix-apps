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
import { extractAppPermissionSpecs, PERMISSIONS_APPS_PATH } from './validate'

interface LiveAppPermissions {
  name?: string
  perms?: { read?: string[]; write?: string[] }
}

/**
 * Health check for app-permission configuration:
 *   1. The app-permissions list is readable via ACS (also proves token validity)
 *   2. Every declared app exists and carries all its declared read/write roles
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

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

  const specs = extractAppPermissionSpecs(ctx.canvas).filter((s) => s.appName)

  const res = await acsRequest(acs, 'GET', `${PERMISSIONS_APPS_PATH}?count=0`)
  if (res.status !== 200) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_reachable',
          passed: false,
          message: `Could not read app permissions via ACS: ${acsErrorMessage(res)}`,
        },
      ],
    }
  }
  checks.push({ name: 'acs_reachable', passed: true, message: `ACS reachable for stack "${stack}"` })

  const parsed = parseJson<{ apps?: LiveAppPermissions[] }>(res.body)
  const liveByApp = new Map<string, { read: string[]; write: string[] }>()
  for (const item of parsed?.apps ?? []) {
    if (!item.name) continue
    liveByApp.set(item.name, { read: item.perms?.read ?? [], write: item.perms?.write ?? [] })
  }

  for (const spec of specs) {
    const live = liveByApp.get(spec.appName)
    if (!live) {
      checks.push({
        name: `app_${spec.appName}`,
        passed: false,
        message: `App "${spec.appName}" not found on stack`,
      })
      continue
    }
    const missingRead = spec.readRoles.filter((r) => !live.read.includes(r))
    const missingWrite = spec.writeRoles.filter((r) => !live.write.includes(r))
    const missing = [...missingRead.map((r) => `read:${r}`), ...missingWrite.map((r) => `write:${r}`)]
    checks.push({
      name: `app_${spec.appName}`,
      passed: missing.length === 0,
      message:
        missing.length === 0
          ? `App "${spec.appName}": all declared roles present (read ${spec.readRoles.length}, write ${spec.writeRoles.length})`
          : `App "${spec.appName}": missing ${missing.length} role assignment(s): ${missing.join(', ')}`,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 100
  return { healthy: score >= 80, score, checks }
}
