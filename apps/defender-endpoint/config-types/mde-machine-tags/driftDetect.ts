// =============================================================================
// Drift detection: compare the deployed device tags against what is live.
//
// A declared device that no longer resolves is CRITICAL drift; a declared tag
// missing from a resolved device is a WARNING. No actor attribution is attached:
// unlike indicators and detection rules, the Machine resource carries NO per-tag
// audit stamps (who added / removed a tag, and when), and Defender exposes no
// config-change audit log for tags — so a tag change is not attributable here.
// =============================================================================

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { resolveMachines } from './deploy'
import { extractMachineTagSpecs, tagKey } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractMachineTagSpecs(ctx.deployedConfig).filter((s) => s.deviceValue && s.tags.length > 0)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    for (const spec of specs) {
      const resolved = await resolveMachines(client, spec)
      if (!resolved.ok) {
        diffs.push({ field: `device:${spec.deviceValue}`, expected: 'reachable', actual: `unreachable: ${resolved.error}`, severity: 'critical' })
        continue
      }
      if (resolved.machines.length === 0) {
        diffs.push({ field: `device:${spec.deviceValue}`, expected: 'exists', actual: 'not found', severity: 'critical' })
        continue
      }
      for (const machine of resolved.machines) {
        const deviceLabel = machine.computerDnsName ?? machine.id ?? spec.deviceValue
        const present = new Set((machine.machineTags ?? []).map(tagKey))
        for (const tag of spec.tags) {
          if (!present.has(tagKey(tag))) {
            diffs.push({ field: `${deviceLabel}.tag:${tag}`, expected: 'present', actual: 'missing', severity: 'warning' })
          }
        }
      }
    }
  } catch (error) {
    diffs.push({ field: 'mde', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
