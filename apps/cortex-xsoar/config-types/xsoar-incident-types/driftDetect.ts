import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildXsoarClient } from '../../lib/xsoar'
import { listIncidentTypes } from './deploy'
import { extractIncidentTypeSpecs, type LiveIncidentType } from './validate'

/**
 * Detect drift between the deployed incident-type configuration and the live
 * server. A missing type is critical drift; a changed default playbook or
 * disabled/auto-run flag is informational drift.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildXsoarClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractIncidentTypeSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listIncidentTypes(client)
    const byName = new Map<string, LiveIncidentType>(live.filter((t) => t.name).map((t) => [t.name as string, t]))

    for (const spec of specs) {
      const found = byName.get(spec.name)
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      const livePlaybook = typeof found.playbookId === 'string' ? found.playbookId : ''
      if ((spec.playbookId ?? '') !== livePlaybook) {
        diffs.push({
          field: `${spec.name}.playbookId`,
          expected: spec.playbookId ?? 'not set',
          actual: livePlaybook || 'not set',
          severity: 'info',
        })
      }
      const liveDisabled = found.disabled ?? false
      if (liveDisabled !== spec.disabled) {
        diffs.push({ field: `${spec.name}.disabled`, expected: String(spec.disabled), actual: String(liveDisabled), severity: 'info' })
      }
      const liveAutorun = found.autorun ?? false
      if (liveAutorun !== spec.autorun) {
        diffs.push({ field: `${spec.name}.autorun`, expected: String(spec.autorun), actual: String(liveAutorun), severity: 'info' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'cortex-xsoar',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
