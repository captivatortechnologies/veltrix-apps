import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildFalconClient, falconErrorMessage } from '../../lib/falcon'
import { findEntityByIdentity } from '../../lib/entityAdapter'
import { IT_SCHEDULED_TASK_ENDPOINTS } from './deploy'
import { extractScheduledTaskSpecs, type LiveScheduledTask } from './validate'

/**
 * Health check for scheduled task configuration:
 *   1. Falcon API reachability + credential validity (IT automation scope)
 *   2. Every declared scheduled task exists (by task_id) and — when the live
 *      resource exposes enablement — matches the declared active state.
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
    const res = await client.request('GET', IT_SCHEDULED_TASK_ENDPOINTS.queries, { query: { limit: 1 } })
    if (res.status === 401) throw new Error('Falcon API client rejected (401) — check the client secret')
    if (res.status === 403) {
      throw new Error('Falcon API client lacks the "IT automation scheduled tasks: Read" scope (403)')
    }
    if (!res.ok) throw new Error(falconErrorMessage(res))
    return `Falcon API reachable at ${baseUrl}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractScheduledTaskSpecs(ctx.canvas).filter((s) => s.taskId)
    for (const spec of specs) {
      checks.push(
        await timedCheck(`scheduled-task:${spec.name}`, async () => {
          const live = (await findEntityByIdentity(
            client,
            IT_SCHEDULED_TASK_ENDPOINTS,
            spec.taskId,
          )) as LiveScheduledTask | null
          if (!live) {
            throw new Error(`Scheduled task for task "${spec.taskId}" does not exist in the tenant`)
          }
          if (typeof live.is_active === 'boolean' && live.is_active !== spec.enabled) {
            throw new Error(
              `Scheduled task "${spec.name}" is ${live.is_active ? 'active' : 'inactive'} but should be ${
                spec.enabled ? 'active' : 'inactive'
              }`,
            )
          }
          return `Scheduled task "${spec.name}" is present and matches the declared state`
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
