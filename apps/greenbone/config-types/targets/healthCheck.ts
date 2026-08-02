import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { withGmpSession, resolveGmpHost, resolveGmpPort, buildGetVersionCommand, parseGmpStatus, parseRootAttributes } from '../../lib/greenboneApi'

/**
 * Health for the targets config = gvmd accepts a GMP connection, authenticates the
 * configured username/password, and answers <get_version/>. withGmpSession()
 * authenticates first, so reaching the callback already proves reachability + auth.
 * Read-only. Applied over GMP (XML over TLS, 9390).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheck[] = []

  if (!credential || !credential.username || !credential.password) {
    checks.push({ name: 'credential', passed: false, message: 'No username/password credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  try {
    const version = await withGmpSession(
      { host: resolveGmpHost(component, connectivity), port: resolveGmpPort(component), timeoutMs: 8000 },
      { username: credential.username, password: credential.password },
      async (session) => {
        const raw = await session.send(buildGetVersionCommand())
        const st = parseGmpStatus(raw)
        if (!st.ok) throw new Error(`get_version returned status ${st.status}`)
        return /<version>([\s\S]*?)<\/version>/.exec(raw)?.[1] ?? parseRootAttributes(raw).status_text ?? 'unknown'
      },
    )
    checks.push({
      name: 'gvmd_reachable',
      passed: true,
      message: `Authenticated to gvmd over GMP (version ${version}).`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'gvmd_reachable',
      passed: false,
      message: `gvmd unreachable or authentication failed: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
