import type { HealthCheckContext, HealthCheckResult } from '../../../../core/pipeline-engine/types'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
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

  // Check 2: Authorization endpoint accessible
  checks.push(await timedCheck('roles_accessible', async () => {
    const res = await fetch(`${baseUrl}/services/authorization/roles?output_mode=json&count=1`, { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Roles endpoint returned ${res.status}`)
    return 'Role configuration is accessible'
  }))

  // Check 3: Authentication subsystem
  checks.push(await timedCheck('auth_subsystem', async () => {
    const res = await fetch(`${baseUrl}/services/authentication/users?output_mode=json&count=1`, { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Auth endpoint returned ${res.status}`)
    return 'Authentication subsystem is healthy'
  }))

  const passedCount = checks.filter(c => c.passed).length
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

function buildSplunkUrl(component: HealthCheckContext['component'], connectivity: NonNullable<HealthCheckContext['connectivity']>): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<HealthCheckContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  return { Authorization: `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}` }
}
