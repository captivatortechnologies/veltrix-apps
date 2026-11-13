import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, parseEntityContent, splunkFetch } from '../../lib/splunkApi'
import { APP_BASE_PATH } from './deploy'
import { resolveAppId } from '../../lib/splunkPackage'

/**
 * Health check for Splunk app configuration.
 * Verifies the instance is reachable and that every app declared on the canvas
 * is installed and in its expected enabled/disabled state.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const checks: HealthCheckResult['checks'] = []

  // Scope by Target Server Types: this config only deploys to servers whose role is
  // selected, so a server outside that set has nothing to check — report healthy
  // rather than failing (e.g. an indexer for a Deployment-Server-only config).
  const componentRoles = component.type ?? []
  const targetedSections = canvas.sections.filter(s => {
    const raw = s.fields?.targetTypes
    const targets = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(',').map(x => x.trim()).filter(Boolean) : []
    return targets.length === 0 || targets.some(role => componentRoles.includes(role))
  })
  if (targetedSections.length === 0) return { healthy: true, score: 100, checks: [{ name: 'scope', passed: true, message: 'Not a target role for this configuration - nothing to check' }] }

  if (!credential) {
    return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: 'Missing credential' }] }
  }

  const baseUrl = buildSplunkUrl(component, connectivity, connectivityProvider, ctx.settings)
  const auth = buildAuthHeader(credential)

  // Check 1: Server reachable
  checks.push(await timedCheck('server_reachable', async () => {
    const res = await splunkFetch(`${baseUrl}/services/server/info?output_mode=json`, { method: 'GET', headers: auth, timeoutMs: 10_000 })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const server = parseEntityContent(await res.text())
    if (typeof server.version !== 'string' || !server.version) throw new Error('Endpoint did not return Splunk server information')
    return 'Splunk instance is reachable'
  }))

  // Check 2: Canvas apps are installed and in the expected state
  checks.push(await timedCheck('canvas_apps_present', async () => {
    const expected = targetedSections
      .map((s) => ({ name: resolveAppId(s.fields ?? {}, canvas.name), state: (s.fields?.state as string | undefined) ?? 'enabled' }))
      .filter((a): a is { name: string; state: string } => Boolean(a.name))
    if (expected.length === 0) return 'No apps declared on canvas'

    const missing: string[] = []
    const wrongState: string[] = []
    for (const app of expected) {
      const res = await splunkFetch(`${baseUrl}${APP_BASE_PATH}/${encodeURIComponent(app.name)}?output_mode=json`, {
        method: 'GET', headers: auth, timeoutMs: 10_000,
      })
      if (!res.ok) {
        missing.push(app.name)
        continue
      }
      const content = parseEntityContent(await res.text())
      const disabled = content?.disabled === true || content?.disabled === '1' || content?.disabled === 1
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
