import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCloudflareClient } from '../../lib/cloudflare'
import { getEntrypoint } from './deploy'
import { extractTransformRuleSpecs, type LiveRule } from './validate'

/**
 * Detect drift between the deployed transform rules and the live phase
 * entrypoints. Each declared rule is re-found by `ref` inside its own phase
 * (entrypoints are read once per phase and cached) and the managed fields
 * (expression, enabled) are diffed; a missing rule is critical drift. The action
 * is always `rewrite`, so it is not diffed.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTransformRuleSpecs(ctx.deployedConfig).filter((s) => s.name && s.expression && s.phase)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    // Cache the ref→rule map per phase so each phase entrypoint is read only once.
    const rulesByPhase = new Map<string, Map<string, LiveRule>>()

    for (const spec of specs) {
      const phase = spec.phase as string
      let byRef = rulesByPhase.get(phase)
      if (!byRef) {
        const entry = await getEntrypoint(client, phase)
        byRef = new Map<string, LiveRule>(entry.rules.filter((r) => r.ref).map((r) => [r.ref as string, r]))
        rulesByPhase.set(phase, byRef)
      }

      const found = byRef.get(spec.ref)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if ((found.expression ?? '') !== spec.expression) {
        diffs.push({
          field: `${spec.name}.expression`,
          expected: spec.expression,
          actual: found.expression ?? 'not set',
          severity: 'warning',
        })
      }
      if ((found.enabled ?? true) !== spec.enabled) {
        diffs.push({
          field: `${spec.name}.enabled`,
          expected: String(spec.enabled),
          actual: String(found.enabled ?? true),
          severity: 'info',
        })
      }
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
