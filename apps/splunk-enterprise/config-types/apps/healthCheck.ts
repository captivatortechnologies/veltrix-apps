import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'
import { APP_BASE_PATH } from './deploy'

/**
 * Health check for Splunk app configuration.
 * Verifies the instance is reachable and that every app declared on the canvas
 * is installed and in its expected enabled/disabled state.
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

  // Check 2: Canvas apps are installed and in the expected state
  checks.push(await timedCheck('canvas_apps_present', async () => {
    const expected = canvas.sections
      .map((s) => ({ name: s.fields?.name as string | undefined, state: (s.fields?.state as string | undefined) ?? 'enabled' }))
      .filter((a): a is { name: string; state: string } => Boolean(a.name))
    if (expected.length === 0) return 'No apps declared on canvas'

    const missing: string[] = []
    const wrongState: string[] = []
    for (const app of expected) {
      const res = await fetch(`${baseUrl}${APP_BASE_PATH}/${encodeURIComponent(app.name)}?output_mode=json`, {
        method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        missing.push(app.name)
        continue
      }
      const data = JSON.parse(await res.text())
      const content = data?.entry?.[0]?.content
      const disabled = content?.disabled === true || content?.disabled === '1'
      const expectDisabled = app.state === 'disabled'
      if (disabled !== expectDisabled) wrongState.push(app.name)
    }
    if (missing.length > 0) throw new Error(`Missing app(s): ${missing.join(', ')}`)
    if (wrongState.length > 0) throw new Error(`App(s) in the wrong state: ${wrongState.join(', ')}`)
    return `All ${expected.length} canvas app(s) are installed and in the expected state`
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
