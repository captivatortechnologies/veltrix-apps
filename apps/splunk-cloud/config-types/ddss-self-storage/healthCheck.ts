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
import {
  extractSelfStorageSpecs,
  locationKey,
  SELF_STORAGE_BUCKETS_PATH,
  type LiveSelfStorageLocation,
} from './validate'

/**
 * Health check for DDSS self storage configuration:
 *   1. The self storage locations list is readable via ACS (also proves the
 *      token is valid).
 *   2. Every declared location is registered on the stack.
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

  const specs = extractSelfStorageSpecs(ctx.canvas).filter((s) => s.title && s.bucketName)

  const res = await acsRequest(acs, 'GET', SELF_STORAGE_BUCKETS_PATH)
  if (res.status !== 200) {
    return {
      healthy: false,
      score: 0,
      checks: [
        {
          name: 'acs_reachable',
          passed: false,
          message: `Could not read self storage locations via ACS: ${acsErrorMessage(res)}`,
        },
      ],
    }
  }
  checks.push({ name: 'acs_reachable', passed: true, message: `ACS reachable for stack "${stack}"` })

  const parsed = parseJson<
    LiveSelfStorageLocation[] | { selfStorageLocations?: LiveSelfStorageLocation[] }
  >(res.body)
  const live = Array.isArray(parsed) ? parsed : (parsed?.selfStorageLocations ?? [])
  const liveKeys = new Set(live.map((l) => locationKey(l.bucketName ?? '', l.folder ?? '')))
  const liveTitles = new Set(live.map((l) => (l.title ?? '').trim()).filter((t) => t.length > 0))

  for (const spec of specs) {
    const present = liveKeys.has(locationKey(spec.bucketName, spec.folder)) || liveTitles.has(spec.title)
    checks.push({
      name: `location:${spec.title}`,
      passed: present,
      message: present
        ? `Self storage location "${spec.title}" (${spec.bucketName}${spec.folder ? `/${spec.folder}` : ''}) is registered`
        : `Self storage location "${spec.title}" is not registered on the stack`,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 100
  return { healthy: score >= 80, score, checks }
}
