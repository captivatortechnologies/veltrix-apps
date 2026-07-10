import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { HEC_BASE_PATH } from './deploy'

/**
 * Health check for HEC token configuration.
 * Verifies the instance is reachable, the global HEC input is enabled,
 * and every token declared on the canvas exists and is enabled.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, canvas } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || !connectivity) {
    return { healthy: false, score: 0, checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or connectivity' }] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  // Check 1: Server reachable
  checks.push(await timedCheck('server_reachable', async () => {
    const res = await fetch(`${baseUrl}/services/server/info?output_mode=json`, { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    return 'Splunk instance is reachable'
  }))

  // Check 2: Global HEC input is enabled ("http" is the global HEC stanza)
  checks.push(await timedCheck('hec_enabled', async () => {
    const res = await fetch(`${baseUrl}${HEC_BASE_PATH}/http?output_mode=json`, { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HEC global settings endpoint returned ${res.status}`)
    const data = JSON.parse(await res.text())
    const content = data?.entry?.[0]?.content
    if (content?.disabled === true || content?.disabled === '1') {
      throw new Error('HTTP Event Collector is globally disabled on this instance')
    }
    return 'HTTP Event Collector is enabled'
  }))

  // Check 3: Canvas tokens exist and are enabled
  checks.push(await timedCheck('canvas_tokens_present', async () => {
    const expected = canvas.sections
      .map((s) => s.fields?.name as string | undefined)
      .filter((n): n is string => Boolean(n))
    if (expected.length === 0) return 'No HEC tokens declared on canvas'

    const missing: string[] = []
    const disabled: string[] = []
    for (const name of expected) {
      const res = await fetch(`${baseUrl}${HEC_BASE_PATH}/${encodeURIComponent(name)}?output_mode=json`, {
        method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        missing.push(name)
        continue
      }
      const data = JSON.parse(await res.text())
      const content = data?.entry?.[0]?.content
      if (content?.disabled === true || content?.disabled === '1') disabled.push(name)
    }
    if (missing.length > 0) throw new Error(`Missing token(s): ${missing.join(', ')}`)
    if (disabled.length > 0) throw new Error(`Disabled token(s): ${disabled.join(', ')}`)
    return `All ${expected.length} canvas token(s) exist and are enabled`
  }))

  const passedCount = checks.filter((c) => c.passed).length
  return { healthy: passedCount === checks.length, score: Math.round((passedCount / checks.length) * 100), checks }
}

async function timedCheck(name: string, fn: () => Promise<string>): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return { name, passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start }
  }
}
