import type { HealthCheckContext, HealthCheckResult, HealthCheck } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs, hostOverrideKey } from './_shared'

/** Health for this config type: REST API package reachability + credential validity, then per-override presence. Read-only. */
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
    const specs = extractSpecs(items).filter((s) => s.domain)
    try {
      const live = await client.listDnsResolverHostOverrides()
      const keys = new Set(live.filter((o) => o.domain !== undefined).map((o) => hostOverrideKey(o.host ?? '', o.domain)))
      for (const spec of specs) {
        const label = spec.host ? `${spec.host}.${spec.domain}` : spec.domain
        const present = keys.has(hostOverrideKey(spec.host, spec.domain))
        checks.push({ name: `host-override:${label}`, passed: present, message: present ? `Host override "${label}" is present.` : `Host override "${label}" is missing.` })
      }
    } catch (error) {
      checks.push({ name: 'pfsense_host_overrides_list', passed: false, message: `Could not list host overrides: ${error instanceof Error ? error.message : 'error'}` })
    }
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}
