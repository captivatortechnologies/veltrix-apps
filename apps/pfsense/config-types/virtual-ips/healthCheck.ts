import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, vipKey } from './_shared'

/**
 * Health for this config type:
 *   1. REST API package reachability + credential validity (GET /api/v2/system/version)
 *   2. Every declared virtual IP (by subnet) still exists live (one bulk GET)
 * Read-only.
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const checks: HealthCheck[] = []

  if (!hasUsableCredential(credential)) {
    checks.push({ name: 'credential', passed: false, message: MISSING_CREDENTIAL_MESSAGE })
    return { healthy: false, score: 0, checks }
  }

  const settings = readPfsenseSettings(ctx.settings)
  const built = buildPfsenseClient(component, connectivity, credential, settings, connectivityProvider)
  if ('error' in built) {
    checks.push({ name: 'pfsense_credential', passed: false, message: built.error })
    return { healthy: false, score: 0, checks }
  }
  const { client, host } = built

  const auth = await client.authenticate()
  if (auth.error) {
    checks.push({ name: 'pfsense_auth', passed: false, message: auth.error })
    return { healthy: false, score: 0, checks }
  }

  const started = Date.now()
  try {
    await client.getSystemVersion()
    checks.push({ name: 'pfsense_api_reachable', passed: true, message: `pfSense REST API package reachable at ${host}.`, latencyMs: Date.now() - started })
  } catch (error) {
    checks.push({
      name: 'pfsense_api_reachable',
      passed: false,
      message: `pfSense REST API package unreachable or rejected the request: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  if (checks[0]?.passed) {
    const items = canvas.items ?? canvas.sections ?? []
    const specs = extractSpecs(items).filter((s) => s.subnet)
    try {
      const live = await client.listVirtualIps()
      const subnets = new Set(live.filter((v) => v.subnet).map((v) => vipKey(v.subnet)))
      for (const spec of specs) {
        const present = subnets.has(vipKey(spec.subnet))
        checks.push({ name: `vip:${spec.subnet}`, passed: present, message: present ? `Virtual IP "${spec.subnet}" is present.` : `Virtual IP "${spec.subnet}" is missing.` })
      }
    } catch (error) {
      checks.push({ name: 'pfsense_vips_list', passed: false, message: `Could not list virtual IPs: ${error instanceof Error ? error.message : 'error'}` })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
