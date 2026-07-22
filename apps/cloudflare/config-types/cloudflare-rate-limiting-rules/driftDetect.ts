import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { getEntrypoint } from './deploy'
import { extractRateLimitRuleSpecs, type LiveRule } from './validate'

/**
 * Detect drift between the deployed rate limiting rules and the live phase
 * entrypoint. Re-finds each declared rule by `ref` and diffs the managed fields
 * (action, expression, enabled); a missing rule is critical drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractRateLimitRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.expression && s.ratelimitJson.trim())
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  // Connection identity our own deploys appear under — excluded so attribution
  // reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const entry = await getEntrypoint(client)
    const byRef = new Map<string, LiveRule>(entry.rules.filter((r) => r.ref).map((r) => [r.ref as string, r]))

    for (const spec of specs) {
      const before = diffs.length
      const found = byRef.get(spec.ref)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.name, excludeActorLogins })
        continue
      }
      if ((found.action ?? '') !== spec.action) {
        diffs.push({ field: `${spec.name}.action`, expected: spec.action, actual: found.action ?? 'not set', severity: 'warning' })
      }
      if ((found.expression ?? '') !== spec.expression) {
        diffs.push({ field: `${spec.name}.expression`, expected: spec.expression, actual: found.expression ?? 'not set', severity: 'warning' })
      }
      if ((found.enabled ?? true) !== spec.enabled) {
        diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(found.enabled ?? true), severity: 'info' })
      }
      // Attribute every diff this rule produced to the last human change (once).
      await attachDriftActor(client, diffs.slice(before), { targetId: found.id, targetName: spec.name, excludeActorLogins })
    }
  } catch (error) {
    diffs.push({
      field: 'cloudflare',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
