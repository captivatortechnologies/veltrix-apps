import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { LICENSE_POOLS_PATH } from './deploy'

/**
 * Health check for license pool configuration.
 * Verifies the instance is reachable and every pool declared on the canvas
 * exists on its expected licensing stack. Quota is checked for presence
 * (non-zero) rather than exact-byte equality — Splunk's REST response
 * normalizes "500GB" to a raw byte count, and confirming the DECLARED vs
 * ACTUAL byte value precisely is drift-detection's job (driftDetect.ts),
 * not a pass/fail health gate.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || (!connectivity && !connectivityProvider)) {
    return { healthy: false, score: 0, checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or connectivity' }] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  checks.push(await timedCheck('server_reachable', async () => {
    const res = await splunkFetch(`${baseUrl}/services/server/info?output_mode=json`, { method: 'GET', headers: auth, timeoutMs: 10_000 })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    return 'Splunk instance is reachable'
  }))

  checks.push(await timedCheck('canvas_pools_present', async () => {
    const expected = canvas.sections
      .map((s) => ({ name: s.fields?.name as string | undefined, stackId: s.fields?.stackId as string | undefined }))
      .filter((p): p is { name: string; stackId: string | undefined } => Boolean(p.name))
    if (expected.length === 0) return 'No license pools declared on canvas'

    const missing: string[] = []
    const wrongStack: string[] = []
    const zeroQuota: string[] = []
    for (const pool of expected) {
      const res = await splunkFetch(`${baseUrl}${LICENSE_POOLS_PATH}/${encodeURIComponent(pool.name)}?output_mode=json`, {
        method: 'GET', headers: auth, timeoutMs: 10_000,
      })
      if (!res.ok) {
        missing.push(pool.name)
        continue
      }
      const data = JSON.parse(await res.text())
      const content = data?.entry?.[0]?.content
      if (pool.stackId && content?.stack_id && String(content.stack_id) !== pool.stackId) {
        wrongStack.push(`${pool.name} (on ${content.stack_id}, expected ${pool.stackId})`)
      }
      const quota = Number(content?.quota ?? 0)
      if (!Number.isFinite(quota) || quota <= 0) zeroQuota.push(pool.name)
    }
    if (missing.length > 0) throw new Error(`Missing pool(s): ${missing.join(', ')}`)
    if (wrongStack.length > 0) throw new Error(`Pool(s) on the wrong stack: ${wrongStack.join(', ')}`)
    if (zeroQuota.length > 0) throw new Error(`Pool(s) with no usable quota: ${zeroQuota.join(', ')}`)
    return `All ${expected.length} canvas pool(s) exist with a usable quota on their expected stack`
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
