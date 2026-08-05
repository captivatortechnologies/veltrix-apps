import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { globalIpRangesFromList, LIST_GLOBAL_IP_RANGES } from './_shared'

/** Health for Network Ranges = the API key + account id can list Global IP Ranges. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cato_credential', passed: false, message: built.error }] }
  }
  const started = Date.now()
  const res = await built.client.graphql(LIST_GLOBAL_IP_RANGES, { accountId: built.accountId })
  const latencyMs = Date.now() - started
  const err = responseError(res)
  if (err) {
    return { healthy: false, score: 0, checks: [{ name: 'cato_reachable', passed: false, message: `Failed to read Network Ranges: ${err}`, latencyMs }] }
  }
  const ranges = globalIpRangesFromList(res.data)
  return {
    healthy: true,
    score: 100,
    checks: [{ name: 'cato_reachable', passed: true, message: `Connected to Cato account ${built.accountId} (${ranges.length} network range(s))`, latencyMs }],
  }
}
