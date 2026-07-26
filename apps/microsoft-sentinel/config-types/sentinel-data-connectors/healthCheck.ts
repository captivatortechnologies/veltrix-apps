import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildSentinelClient, SENTINEL_API_VERSION, type SentinelClient } from '../../lib/sentinel'
import { connectorKey, extractDataConnectorSpecs } from './validate'

export interface LiveDataConnector {
  name?: string
  kind?: string
  properties?: { tenantId?: string; dataTypes?: Record<string, { state?: string }> }
}

/** List the workspace's data connectors; throws on a non-OK response. */
export async function listDataConnectors(client: SentinelClient): Promise<LiveDataConnector[]> {
  const res = await client.getAll<LiveDataConnector>(client.sentinelPath('/dataConnectors'), SENTINEL_API_VERSION)
  if (!res.ok) {
    throw new Error(res.body ? res.body.slice(0, 300) : `HTTP ${res.status}`)
  }
  return res.items
}

/**
 * Health check for data connectors:
 *   1. ARM reachability + token/permission validity (a dataConnectors list)
 *   2. Every declared connector still exists
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildSentinelClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'sentinel_credential', passed: false, message: built.error }] }
  }
  const { client, armHost } = built

  const start = Date.now()
  let live: LiveDataConnector[] | null = null
  try {
    live = await listDataConnectors(client)
    checks.push({ name: 'arm_reachable', passed: true, message: `Azure Resource Manager reachable at ${armHost}`, latencyMs: Date.now() - start })
  } catch (error) {
    checks.push({ name: 'arm_reachable', passed: false, message: error instanceof Error ? error.message : 'Check failed', latencyMs: Date.now() - start })
  }

  if (live) {
    const ids = new Set(live.filter((c) => c.name).map((c) => (c.name as string).toLowerCase()))
    for (const spec of extractDataConnectorSpecs(ctx.canvas).filter((s) => s.connectorId)) {
      const present = ids.has(connectorKey(spec.connectorId))
      checks.push({
        name: `connector:${spec.connectorId}`,
        passed: present,
        message: present ? `Data connector "${spec.connectorId}" is present` : `Data connector "${spec.connectorId}" is missing`,
      })
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)
  return { healthy: passedCount === checks.length, score, checks }
}
