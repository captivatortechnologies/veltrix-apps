import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { getEntrypoint } from './deploy'
import { extractTransformRuleSpecs } from './validate'

/**
 * Health check for transform rule configuration:
 *   1. Cloudflare API reachability + zone resolution
 *   2. Every declared rule (by ref) is present in its phase entrypoint
 * Because a canvas can span three phases, entrypoints are read once per phase and
 * cached. Score is the percentage of passed checks (0–100).
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
    const specs = extractTransformRuleSpecs(ctx.canvas).filter((s) => s.name && s.expression && s.phase)
    if (specs.length > 0) {
      // Cache the ref set per phase so each phase entrypoint is read only once.
      const refsByPhase = new Map<string, Set<string>>()
      for (const spec of specs) {
        const phase = spec.phase as string
        let refs = refsByPhase.get(phase)
        if (!refs) {
          const entry = await getEntrypoint(client, phase)
          refs = new Set(entry.rules.map((r) => r.ref).filter((ref): ref is string => Boolean(ref)))
          refsByPhase.set(phase, refs)
        }
        const present = refs.has(spec.ref)
        checks.push({
          name: `rule:${spec.name}`,
          passed: present,
          message: present
            ? `Rule "${spec.name}" is present in phase ${phase}`
            : `Rule "${spec.name}" (ref ${spec.ref}) is missing from phase ${phase}`,
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
