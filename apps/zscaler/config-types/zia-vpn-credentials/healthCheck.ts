import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildZscalerClient, parseJson, zscalerErrorMessage } from '../../lib/zscaler'
import { listVpnCredentials } from './deploy'
import { credentialIdentity, extractVpnCredentialSpecs, liveCredentialIdentity } from './validate'

/**
 * Health check for VPN credential configuration:
 *   1. ZIA API reachability + credential validity (GET /status)
 *   2. Every declared VPN credential still exists in the tenant (matched by
 *      identity — fqdn/ip_address; the write-only PSK is never inspected)
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildZscalerClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'zscaler_credential', passed: false, message: built.error }],
    }
  }
  const { client, vanity } = built

  const reachable = await timedCheck('zia_reachable', async () => {
    const res = await client.activationStatus()
    if (res.status === 401 || res.status === 403) {
      throw new Error('Zscaler rejected the OneAPI credential (check the API client id/secret and its ZIA roles)')
    }
    if (!res.ok) throw new Error(zscalerErrorMessage(res))
    const status = parseJson<{ status?: string }>(res.body)?.status
    return `ZIA reachable on tenant "${vanity}"${status ? ` (activation status: ${status})` : ''}`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractVpnCredentialSpecs(ctx.canvas).filter((s) => s.type && credentialIdentity(s))
    if (specs.length > 0) {
      const live = await listVpnCredentials(client)
      const identities = new Set(
        live.map((c) => liveCredentialIdentity(c)).filter((id) => id).map((id) => id.toLowerCase()),
      )
      for (const spec of specs) {
        const identity = credentialIdentity(spec)
        const present = identities.has(identity.toLowerCase())
        checks.push({
          name: `vpn-credential:${identity}`,
          passed: present,
          message: present
            ? `VPN credential "${identity}" is present`
            : `VPN credential "${identity}" does not exist in the tenant`,
        })
      }
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
