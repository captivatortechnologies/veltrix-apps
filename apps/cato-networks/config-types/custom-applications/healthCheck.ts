import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCatoClient, responseError } from '../../lib/cato'
import { customApplicationsFromList, LIST_CUSTOM_APPLICATIONS } from './_shared'

/** Health for Custom Applications = the API key + account id can list them. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const built = buildCatoClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { healthy: false, score: 0, checks: [{ name: 'cato_credential', passed: false, message: built.error }] }
  }
  const started = Date.now()
  const res = await built.client.graphql(LIST_CUSTOM_APPLICATIONS, { accountId: built.accountId })
  const latencyMs = Date.now() - started
  const err = responseError(res)
  if (err) {
    return { healthy: false, score: 0, checks: [{ name: 'cato_reachable', passed: false, message: `Failed to read Custom Applications: ${err}`, latencyMs }] }
  }
  const apps = customApplicationsFromList(res.data)
  return {
    healthy: true,
    score: 100,
    checks: [{ name: 'cato_reachable', passed: true, message: `Connected to Cato account ${built.accountId} (${apps.length} custom application(s))`, latencyMs }],
  }
}
