import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient, cloudflareErrorMessage } from '../../lib/cloudflare'
import { listDnsRecords } from './deploy'
import { dnsRecordKey, extractDnsRecordSpecs } from './validate'

/**
 * Health check for DNS record configuration:
 *   1. Cloudflare API reachability + zone resolution (the token works, zone found)
 *   2. Every declared record (type, name, content) still exists in the zone
 * Score is the percentage of passed checks (0–100).
 */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const checks: HealthCheckResult['checks'] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return {
      healthy: false,
      score: 0,
      checks: [{ name: 'cloudflare_credential', passed: false, message: built.error }],
    }
  }
  const { client, domain } = built

  const reachable = await timedCheck('cloudflare_reachable', async () => {
    const zone = await client.resolveZone()
    if ('error' in zone) throw new Error(zone.error)
    return `Cloudflare reachable; resolved zone for "${domain}"`
  })
  checks.push(reachable)

  if (reachable.passed) {
    const specs = extractDnsRecordSpecs(ctx.canvas).filter((s) => s.type && s.name && s.content)
    if (specs.length > 0) {
      const live = await listDnsRecords(client)
      const keys = new Set(
        live
          .filter((r) => r.type && r.name && r.content)
          .map((r) => dnsRecordKey({ type: r.type as string, name: r.name as string, content: r.content as string })),
      )
      for (const spec of specs) {
        const present = keys.has(dnsRecordKey(spec))
        checks.push({
          name: `record:${spec.type} ${spec.name}`,
          passed: present,
          message: present ? `Record "${spec.type} ${spec.name}" is present` : `Record "${spec.type} ${spec.name}" is missing`,
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
