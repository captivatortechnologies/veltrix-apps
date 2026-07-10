import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader } from '../../lib/splunkApi'

const MIN_FREE_DISK_PCT = 5

/**
 * Health check for Splunk index configuration.
 * Verifies the instance is reachable, splunkd reports healthy, the indexes
 * declared on the canvas exist and are enabled, and index partitions have
 * free disk space.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, canvas } = ctx
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
  checks.push(await timedCheck('server_reachable', async () => {
    const res = await fetch(`${baseUrl}/services/server/info?output_mode=json`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = JSON.parse(await res.text())
    const version = data?.entry?.[0]?.content?.version
    return version ? `Splunk ${version} is reachable` : 'Splunk instance is reachable'
  }))

  // Check 2: Splunkd service status
  checks.push(await timedCheck('splunkd_status', async () => {
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
  }))

  // Check 3: Canvas indexes exist and are enabled
  checks.push(await timedCheck('canvas_indexes_present', async () => {
    const expected = canvas.sections
      .map((s) => s.fields?.name as string | undefined)
      .filter((n): n is string => Boolean(n))
    if (expected.length === 0) return 'No indexes declared on canvas'

    const missing: string[] = []
    const disabled: string[] = []
    for (const name of expected) {
      const res = await fetch(
        `${baseUrl}/services/data/indexes/${encodeURIComponent(name)}?output_mode=json`,
        { method: 'GET', headers: auth, signal: AbortSignal.timeout(10_000) },
      )
      if (!res.ok) {
        missing.push(name)
        continue
      }
      const data = JSON.parse(await res.text())
      const content = data?.entry?.[0]?.content
      if (content?.disabled === true || content?.disabled === '1') disabled.push(name)
    }
    if (missing.length > 0) throw new Error(`Missing index(es): ${missing.join(', ')}`)
    if (disabled.length > 0) throw new Error(`Disabled index(es): ${disabled.join(', ')}`)
    return `All ${expected.length} canvas index(es) exist and are enabled`
  }))

  // Check 4: Disk space on index partitions
  checks.push(await timedCheck('disk_space', async () => {
    const res = await fetch(`${baseUrl}/services/server/status/partitions-space?output_mode=json`, {
      method: 'GET',
      headers: auth,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Partitions endpoint returned ${res.status}`)
    const data = JSON.parse(await res.text())
    const entries: Array<{ content?: Record<string, unknown> }> = data?.entry || []
    if (entries.length === 0) return 'No partition data reported'

    let lowest = 100
    let lowestMount = ''
    for (const entry of entries) {
      const capacity = Number(entry.content?.capacity)
      const free = Number(entry.content?.free)
      if (!capacity || Number.isNaN(free)) continue
      const freePct = (free / capacity) * 100
      if (freePct < lowest) {
        lowest = freePct
        lowestMount = String(entry.content?.mount_point ?? 'unknown')
      }
    }
    if (lowest < MIN_FREE_DISK_PCT) {
      throw new Error(`Partition ${lowestMount} has only ${lowest.toFixed(1)}% free disk space`)
    }
    return `Lowest partition free space: ${lowest.toFixed(1)}%`
  }))

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
