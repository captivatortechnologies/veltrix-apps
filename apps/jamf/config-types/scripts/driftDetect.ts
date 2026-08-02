import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listScripts } from './deploy'
import { extractScriptSpecs, indexScriptsByName, PARAMETER_KEYS, scriptKey, type ScriptSpec } from './validate'

/**
 * Detect drift between the deployed script configuration and the live Jamf
 * Pro tenant. Re-finds each declared script by name and diffs the managed
 * fields: a missing script is critical drift, as is a changed `scriptContents`
 * (the actual payload a policy runs); every other metadata change is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractScriptSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listScripts(client, ctx.settings)
    const byName = indexScriptsByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(scriptKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffField(diffs, label, 'scriptContents', spec.scriptContents, found.scriptContents ?? '', 'critical')
      diffField(diffs, label, 'priority', spec.priority, found.priority ?? '', 'warning')
      diffField(diffs, label, 'info', spec.info, found.info ?? '', 'warning')
      diffField(diffs, label, 'notes', spec.notes, found.notes ?? '', 'warning')
      diffField(diffs, label, 'categoryName', spec.categoryName, found.categoryName ?? '', 'warning')
      diffField(diffs, label, 'osRequirements', spec.osRequirements, found.osRequirements ?? '', 'warning')
      for (const key of PARAMETER_KEYS) {
        diffField(diffs, label, key, spec[key as keyof ScriptSpec] as string, found[key] ?? '', 'warning')
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Push a diff when the declared and live values differ; no-op otherwise. */
function diffField(
  diffs: DriftDiff[],
  label: string,
  field: string,
  expected: string,
  actual: string,
  severity: DriftDiff['severity'],
): void {
  if (expected === actual) return
  diffs.push({ field: `${label}.${field}`, expected: expected || '(empty)', actual: actual || '(empty)', severity })
}
