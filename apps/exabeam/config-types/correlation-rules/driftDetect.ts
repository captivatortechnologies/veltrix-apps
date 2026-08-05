import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildExabeamClient, stableStringify } from '../../lib/exabeam'
import { listRules } from './deploy'
import { extractRuleSpecs, parseRuleSpec } from './validate'

/**
 * Detect drift between the deployed correlation-rule configuration and live
 * Exabeam state. Each declared rule is re-found by name and its meaningful
 * fields are compared: description, severity, enabled, testMode, and a
 * structural (sorted-key) comparison of sequencesConfig / suppressConfig /
 * delayConfig / scheduleConfig.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildExabeamClient(ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const listed = await listRules(client)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byName = new Map(listed.rules.filter((r) => r.name).map((r) => [r.name as string, r]))

  const specs = extractRuleSpecs(ctx.deployedConfig).filter((s) => s.name)

  for (const spec of specs) {
    const ignoredErrors: Array<{ field: string; message: string; code: string }> = []
    const parsed = parseRuleSpec(spec, spec.name, ignoredErrors)
    if (!parsed) continue // unparsable declared config can't be diffed meaningfully

    const live = byName.get(spec.name)
    if (!live) {
      diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
      continue
    }

    const liveDescription = live.description ?? ''
    const expectedDescription = spec.description ?? ''
    if (expectedDescription !== liveDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: spec.description ?? 'not set',
        actual: live.description ?? 'not set',
        severity: 'warning',
      })
    }

    const liveSeverity = (live.severity ?? '').toLowerCase()
    if (spec.severity !== liveSeverity) {
      diffs.push({ field: `${spec.name}.severity`, expected: spec.severity, actual: liveSeverity || 'not set', severity: 'warning' })
    }

    const liveEnabled = live.enabled === true
    if (spec.enabled !== liveEnabled) {
      diffs.push({ field: `${spec.name}.enabled`, expected: spec.enabled, actual: liveEnabled, severity: 'critical' })
    }

    const liveTestMode = live.testMode === true
    if (spec.testMode !== liveTestMode) {
      diffs.push({ field: `${spec.name}.testMode`, expected: spec.testMode, actual: liveTestMode, severity: 'warning' })
    }

    if (stableStringify(parsed.sequencesConfig) !== stableStringify(live.sequencesConfig ?? {})) {
      diffs.push({
        field: `${spec.name}.sequencesConfig`,
        expected: 'declared sequences config',
        actual: 'differs from live sequences config',
        severity: 'critical',
      })
    }

    for (const [key, label] of [
      ['suppressConfig', 'suppressConfig'],
      ['delayConfig', 'delayConfig'],
      ['scheduleConfig', 'scheduleConfig'],
    ] as const) {
      const expected = parsed[key] ?? {}
      const actual = (live[key] as Record<string, unknown> | undefined) ?? {}
      if (stableStringify(expected) !== stableStringify(actual)) {
        diffs.push({
          field: `${spec.name}.${label}`,
          expected: `declared ${label}`,
          actual: `differs from live ${label}`,
          severity: 'warning',
        })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
