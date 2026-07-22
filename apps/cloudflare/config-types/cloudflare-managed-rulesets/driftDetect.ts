import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { attachDriftActor, veltrixActorLogins } from '../lib/cloudflareAudit'
import { getEntrypoint } from './deploy'
import { extractManagedRulesetSpecs, type LiveRule } from './validate'

/**
 * Detect drift between the deployed managed rulesets and the live phase
 * entrypoint. Re-finds each declared deployment by `ref` and checks presence and
 * the enabled flag; a missing rule is critical drift. We do NOT diff the managed
 * ruleset's rules — a managed ruleset is read-only and Cloudflare updates its
 * contents over time, so only the deployment's presence and enabled state are
 * managed here.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractManagedRulesetSpecs(ctx.deployedConfig).filter((s) => s.name && s.managedRulesetId)
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
      if ((found.enabled ?? true) !== spec.enabled) {
        diffs.push({ field: `${spec.name}.enabled`, expected: String(spec.enabled), actual: String(found.enabled ?? true), severity: 'info' })
      }
      // Attribute every diff this deployment produced to the last human change (once).
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
