import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildPfsenseClient, hasUsableCredential, MISSING_CREDENTIAL_MESSAGE, readPfsenseSettings } from '../../lib/pfsenseApi'
import { extractSpecs } from './_shared'

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  if (!hasUsableCredential(ctx.credential)) return { healthy: false, score: 0, checks: [{ name: 'credential', passed: false, message: MISSING_CREDENTIAL_MESSAGE }] }
  const built = buildPfsenseClient(ctx.component, ctx.connectivity, ctx.credential, readPfsenseSettings(ctx.settings), ctx.connectivityProvider)
  if ('error' in built) return { healthy: false, score: 0, checks: [{ name: 'pfsense', passed: false, message: built.error }] }
  const auth = await built.client.authenticate()
  if (auth.error) return { healthy: false, score: 0, checks: [{ name: 'pfsense_auth', passed: false, message: auth.error }] }
  try {
    const expected = extractSpecs(ctx.canvas)[0]?.mode
    const actual = await built.client.getOutboundNatMode()
    const passed = Boolean(expected && actual === expected)
    return { healthy: passed, score: passed ? 1 : 0, checks: [{ name: 'outbound_nat_mode', passed, message: passed ? `Outbound NAT mode is ${actual}.` : `Expected ${expected || 'a declared mode'}, found ${actual}.` }] }
  } catch (error) {
    return { healthy: false, score: 0, checks: [{ name: 'pfsense_api', passed: false, message: error instanceof Error ? error.message : 'pfSense request failed' }] }
  }
}
