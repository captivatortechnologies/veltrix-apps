import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildKandjiClient } from '../../lib/kandjiApi'
import { listCustomScripts } from './deploy'
import { customScriptKey, extractCustomScriptSpecs, indexCustomScriptsByName } from './validate'

/**
 * Detect drift between the deployed Custom Script configuration and the live
 * Kandji tenant. Re-finds each declared item by name and diffs every
 * managed field; a missing item is critical drift, a changed field is a
 * warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildKandjiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractCustomScriptSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listCustomScripts(client)
    const byName = indexCustomScriptsByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(customScriptKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((found.script ?? '') !== spec.script) {
        diffs.push({ field: `${label}.script`, expected: spec.script, actual: found.script ?? '', severity: 'warning' })
      }
      if ((found.execution_frequency ?? '') !== spec.executionFrequency) {
        diffs.push({
          field: `${label}.execution_frequency`,
          expected: spec.executionFrequency,
          actual: found.execution_frequency ?? '',
          severity: 'warning',
        })
      }
      if ((found.active ?? true) !== spec.active) {
        diffs.push({ field: `${label}.active`, expected: spec.active, actual: found.active ?? true, severity: 'warning' })
      }
      if ((found.restart ?? false) !== spec.restart) {
        diffs.push({ field: `${label}.restart`, expected: spec.restart, actual: found.restart ?? false, severity: 'warning' })
      }
      if ((found.remediation_script ?? '') !== spec.remediationScript) {
        diffs.push({
          field: `${label}.remediation_script`,
          expected: spec.remediationScript,
          actual: found.remediation_script ?? '',
          severity: 'warning',
        })
      }
      if ((found.show_in_self_service ?? false) !== spec.showInSelfService) {
        diffs.push({
          field: `${label}.show_in_self_service`,
          expected: spec.showInSelfService,
          actual: found.show_in_self_service ?? false,
          severity: 'warning',
        })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'kandji',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
