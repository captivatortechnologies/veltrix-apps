import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildServiceNowClient, serviceNowErrorMessage } from '../../lib/servicenowApi'
import { SYS_SCRIPT_TABLE } from './_shared'

/**
 * Health for the business-rules config type = the instance answers a read of the
 * sys_script table with the configured credential. Read-only:
 * GET /table/sys_script?sysparm_limit=1. A 2xx confirms reachability AND that the
 * credential can read the managed table; 401/403 (auth) and 5xx are unhealthy.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, settings } = ctx
  const checks: HealthCheck[] = []

  const built = buildServiceNowClient(component?.hostname, credential, settings)
  if ('error' in built) {
    checks.push({ name: 'credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client, instanceUrl } = built

  const started = Date.now()
  try {
    const res = await client.list(SYS_SCRIPT_TABLE, { limit: 1, fields: ['sys_id'] })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      checks.push({ name: 'servicenow_auth', passed: false, message: `ServiceNow rejected the credential (HTTP ${res.status}).`, latencyMs })
    } else if (res.ok) {
      checks.push({ name: 'servicenow_reachable', passed: true, message: `ServiceNow reachable at ${instanceUrl} (HTTP ${res.status}).`, latencyMs })
    } else {
      checks.push({ name: 'servicenow_reachable', passed: false, message: `ServiceNow returned HTTP ${res.status}: ${serviceNowErrorMessage(res)}`, latencyMs })
    }
  } catch (error) {
    checks.push({
      name: 'servicenow_reachable',
      passed: false,
      message: `ServiceNow unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
