import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { hasSplunkAddress, buildSplunkUrl, buildAuthHeader, parseEntityContent, splunkFetch } from '../../lib/splunkApi'
import { HEC_BASE_PATH } from './deploy'

/**
 * Health check for HEC token configuration.
 * Verifies the instance is reachable, the global HEC input is enabled,
 * and every token declared on the canvas exists in its desired state.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || !hasSplunkAddress(component, connectivity, connectivityProvider)) {
    return { healthy: false, score: 0, checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or Splunk management address' }] }
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

  // Check 2: Global HEC input is enabled ("http" is the global HEC stanza)
  checks.push(await timedCheck('hec_enabled', async () => {
    const res = await splunkFetch(`${baseUrl}${HEC_BASE_PATH}/http?output_mode=json`, { method: 'GET', headers: auth, timeoutMs: 10_000 })
    if (!res.ok) throw new Error(`HEC global settings endpoint returned ${res.status}`)
    const content = parseEntityContent(await res.text())
    if (content?.disabled === true || content?.disabled === '1' || content?.disabled === 1) {
      throw new Error('HTTP Event Collector is globally disabled on this instance')
    }
    return 'HTTP Event Collector is enabled'
  }))

  // Check 3: Canvas tokens exist and are enabled
  checks.push(await timedCheck('canvas_tokens_present', async () => {
    const expected = canvas.sections
      .map((s) => ({ name: s.fields?.name as string | undefined, enabled: s.fields?.enabled !== false }))
      .filter((token): token is { name: string; enabled: boolean } => Boolean(token.name))
    if (expected.length === 0) return 'No HEC tokens declared on canvas'

    const missing: string[] = []
    const wrongState: string[] = []
    for (const { name, enabled } of expected) {
      const res = await splunkFetch(`${baseUrl}${HEC_BASE_PATH}/${encodeURIComponent(name)}?output_mode=json`, {
        method: 'GET', headers: auth, timeoutMs: 10_000,
      })
      if (!res.ok) {
        missing.push(name)
        continue
      }
      const content = parseEntityContent(await res.text())
      const disabled = content?.disabled === true || content?.disabled === '1' || content?.disabled === 1
      if (disabled === enabled) wrongState.push(name)
    }
    if (missing.length > 0) throw new Error(`Missing token(s): ${missing.join(', ')}`)
    if (wrongState.length > 0) throw new Error(`Token(s) in the wrong state: ${wrongState.join(', ')}`)
    return `All ${expected.length} canvas token(s) exist in the expected enabled/disabled state`
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
