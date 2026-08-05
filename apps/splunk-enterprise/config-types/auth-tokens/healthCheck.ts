import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, splunkFetch } from '../../lib/splunkApi'
import { AUTH_TOKENS_PATH, TOKEN_AUTH_ENABLE_PATH } from './deploy'

/**
 * Health check for API access token configuration.
 * Verifies the instance is reachable, Token Authentication is enabled, and
 * every token declared on the canvas exists (matched by username + audience)
 * with its expected enabled/disabled status.
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

  checks.push(await timedCheck('token_auth_enabled', async () => {
    const res = await splunkFetch(`${baseUrl}${TOKEN_AUTH_ENABLE_PATH}?output_mode=json`, { method: 'GET', headers: auth, timeoutMs: 10_000 })
    if (!res.ok) throw new Error(`Token auth settings endpoint returned ${res.status}`)
    const data = JSON.parse(await res.text())
    const content = data?.entry?.[0]?.content
    if (content?.disabled === true || content?.disabled === '1' || content?.disabled === 1) {
      throw new Error('Token Authentication is disabled on this instance')
    }
    return 'Token Authentication is enabled'
  }))

  checks.push(await timedCheck('canvas_tokens_present', async () => {
    const expected = canvas.sections
      .map((s) => ({
        username: s.fields?.username as string | undefined,
        audience: s.fields?.audience as string | undefined,
        enabled: s.fields?.enabled !== false,
      }))
      .filter((t): t is { username: string; audience: string; enabled: boolean } => Boolean(t.username && t.audience))
    if (expected.length === 0) return 'No API access tokens declared on canvas'

    const missing: string[] = []
    const wrongStatus: string[] = []
    for (const token of expected) {
      const res = await splunkFetch(
        `${baseUrl}${AUTH_TOKENS_PATH}?username=${encodeURIComponent(token.username)}&count=0&output_mode=json`,
        { method: 'GET', headers: auth, timeoutMs: 10_000 },
      )
      if (!res.ok) {
        missing.push(`${token.username} (${token.audience})`)
        continue
      }
      const data = JSON.parse(await res.text())
      const entries: Array<{ content?: Record<string, unknown> }> = data?.entry ?? []
      const match = entries.find((e) => e.content?.audience === token.audience)
      if (!match) {
        missing.push(`${token.username} (${token.audience})`)
        continue
      }
      const liveEnabled = String(match.content?.status ?? 'enabled').toLowerCase() !== 'disabled'
      if (liveEnabled !== token.enabled) {
        wrongStatus.push(`${token.username} (${token.audience})`)
      }
    }
    if (missing.length > 0) throw new Error(`Missing token(s): ${missing.join(', ')}`)
    if (wrongStatus.length > 0) throw new Error(`Token(s) with unexpected status: ${wrongStatus.join(', ')}`)
    return `All ${expected.length} canvas token(s) exist with their expected status`
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
