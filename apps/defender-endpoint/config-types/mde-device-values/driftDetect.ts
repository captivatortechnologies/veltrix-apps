// =============================================================================
// Drift detection: compare the deployed device values against what is live.
//
// A declared device that no longer resolves is CRITICAL drift; a resolved device
// whose live `deviceValue` differs from the declared criticality is a WARNING
// (the diff shows live vs declared). No actor attribution is attached: unlike
// indicators and detection rules, the Machine resource carries NO per-property
// audit stamp (who changed deviceValue, and when), so a change is not
// attributable here.
// =============================================================================

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { resolveMachines } from './deploy'
import { extractDeviceValueSpecs } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractDeviceValueSpecs(ctx.deployedConfig).filter((s) => s.device && s.criticality)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    for (const spec of specs) {
      const resolved = await resolveMachines(client, spec)
      if (!resolved.ok) {
        diffs.push({ field: `device:${spec.device}`, expected: 'reachable', actual: `unreachable: ${resolved.error}`, severity: 'critical' })
        continue
      }
      if (resolved.machines.length === 0) {
        diffs.push({ field: `device:${spec.device}`, expected: 'exists', actual: 'not found', severity: 'critical' })
        continue
      }
      for (const machine of resolved.machines) {
        const deviceLabel = machine.computerDnsName ?? machine.id ?? spec.device
        const live = machine.deviceValue ?? 'Normal'
        if (live !== spec.criticality) {
          diffs.push({ field: `${deviceLabel}.deviceValue`, expected: spec.criticality, actual: live, severity: 'warning' })
        }
      }
    }
  } catch (error) {
    diffs.push({ field: 'mde', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
