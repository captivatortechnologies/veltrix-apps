import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { CID_GROUPS_QUERY, cidGroupIdOf, findCidGroup, getCidGroupMembers } from './deploy'
import { extractCidGroupSpecs } from './validate'

/**
 * Health check for MSSP CID group configuration:
 *   1. Flight Control API reachability + credential validity (parent-CID + MSSP scope)
 *   2. Every declared group exists with all its declared member CIDs present
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildFalconClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'falcon_credential', passed: false, message: built.error }],
    }
  }
  const { client, baseUrl } = built

  const reachable = await timedCheck('falcon_reachable', async () => {
    const res = await client.request('GET', CID_GROUPS_QUERY, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error(
        'Falcon API client lacks the Flight Control (MSSP) scope, or the tenant is not an MSSP parent CID (403)',
      )
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Flight Control API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractCidGroupSpecs(ctx.canvas).filter((s) => s.name)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`cid-group:${spec.name}`, async () => {
          const live = await findCidGroup(client, spec.name)
          if (!live) throw new Error(`CID group "${spec.name}" does not exist in the tenant`)
          const id = cidGroupIdOf(live)
          const liveCids = id ? await getCidGroupMembers(client, id) : []
          const missing = spec.cids.filter((cid) => !liveCids.includes(cid))
          if (missing.length > 0) {
            throw new Error(`CID group "${spec.name}" is missing member CID(s): ${missing.join(', ')}`)
          }
          return `CID group "${spec.name}" is present with all ${spec.cids.length} declared member CID(s)`
        }),
      )
    }
  }

  const passedCount = checks.filter((c) => c.passed).length
  const score = Math.round((passedCount / checks.length) * 100)

  return { healthy: passedCount === checks.length, score, checks }
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
