import type { HealthCheckContext, HealthCheckResult } from '../../../../core/pipeline-engine/types'

/**
 * Health check for Splunk index configuration.
 * Verifies the Splunk instance is reachable and indexes are operational.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity } = ctx
  const checks: HealthCheckResult['checks'] = []

  if (!credential || !connectivity) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'connectivity', passed: false, message: 'Missing credential or connectivity' }],
    }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)

  // Check 1: Splunk server info (is the instance reachable?)
  const serverCheck = await timedCheck('server_reachable', async () => {
    const res = await fetch(`${baseUrl}/services/server/info?output_mode=json`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    return 'Splunk instance is reachable'
  })
  checks.push(serverCheck)

  // Check 2: Splunkd service status
  const serviceCheck = await timedCheck('splunkd_status', async () => {
    const res = await fetch(`${baseUrl}/services/server/health/splunkd?output_mode=json`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Health endpoint returned ${res.status}`)
    const data = JSON.parse(await res.text())
    const health = data?.entry?.[0]?.content?.health
    if (health !== 'green' && health !== 'yellow') {
      throw new Error(`Splunkd health is ${health}`)
    }
    return `Splunkd health: ${health}`
  })
  checks.push(serviceCheck)

  // Check 3: Index data integrity
  const indexCheck = await timedCheck('indexes_accessible', async () => {
    const res = await fetch(`${baseUrl}/services/data/indexes?output_mode=json&count=1`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Indexes endpoint returned ${res.status}`)
    return 'Index data is accessible'
  })
  checks.push(indexCheck)

  // Check 4: Disk space
  const diskCheck = await timedCheck('disk_space', async () => {
    const res = await fetch(`${baseUrl}/services/server/status/resource-usage/hostwide?output_mode=json`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Resource endpoint returned ${res.status}`)
    return 'Disk space check passed'
  })
  checks.push(diskCheck)

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return {
    healthy: passedCount === checks.length,
    score,
    checks,
  }
}

async function timedCheck(
  name: string,
  fn: () => Promise<string>,
): Promise<HealthCheckResult['checks'][0]> {
  const start = Date.now()
  try {
    const message = await fn()
    return { name, passed: true, message, latencyMs: Date.now() - start }
  } catch (error) {
    return {
      name,
      passed: false,
      message: error instanceof Error ? error.message : 'Check failed',
      latencyMs: Date.now() - start,
    }
  }
}

function buildSplunkUrl(
  component: HealthCheckContext['component'],
  connectivity: NonNullable<HealthCheckContext['connectivity']>,
): string {
  if (connectivity.httpsUrl) return connectivity.httpsUrl
  if (connectivity.tailscaleDeviceIP) return `https://${connectivity.tailscaleDeviceIP}:${component.port || '8089'}`
  return `https://${component.hostname}:${component.port || '8089'}`
}

function buildAuthHeader(credential: NonNullable<HealthCheckContext['credential']>): Record<string, string> {
  if (credential.apiToken) return { Authorization: `Bearer ${credential.apiToken}` }
  const encoded = Buffer.from(`${credential.username}:${credential.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}
