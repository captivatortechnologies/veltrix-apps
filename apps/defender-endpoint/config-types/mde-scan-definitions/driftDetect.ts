// =============================================================================
// Drift detection: compare the deployed scan definitions against what is live.
//
// A declared definition that no longer exists is CRITICAL drift; a mismatched
// non-secret field (active state / targets / target type / interval / scanner
// device) is a WARNING. `scanAuthenticationParams` is NEVER compared here — it
// is a credential, and Microsoft's own docs are inconsistent about whether it
// is ever safely readable back at all (see validate.ts) — so a credential-only
// change on the live side is invisible to this drift check by design, not by
// oversight.
//
// No actor attribution: the resource exposes only `createdBy` (who created it —
// there is no last-modified-by / last-modified-time stamp), so a change cannot
// be reliably attributed to a specific person.
// =============================================================================

import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMdeClient } from '../../lib/mde'
import { listScanDefinitions } from './deploy'
import { extractScanDefinitionSpecs, scanNameKey, type LiveScanDefinition } from './validate'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []
  const built = buildMdeClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs: [] }
  const { client } = built

  const specs = extractScanDefinitionSpecs(ctx.deployedConfig).filter((s) => s.scanName && s.targets.length > 0)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listScanDefinitions(client)
    const byKey = new Map<string, LiveScanDefinition>(live.filter((d) => d.scanName).map((d) => [scanNameKey(d.scanName as string), d]))

    for (const spec of specs) {
      const found = byKey.get(scanNameKey(spec.scanName))
      const label = spec.scanName
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }
      if (found.isActive !== spec.isActive) {
        diffs.push({ field: `${label}.isActive`, expected: spec.isActive, actual: Boolean(found.isActive), severity: 'warning' })
      }
      const expectedTarget = spec.targets.join(',')
      if ((found.target ?? '') !== expectedTarget) {
        diffs.push({ field: `${label}.target`, expected: expectedTarget, actual: found.target ?? 'not set', severity: 'warning' })
      }
      if ((found.targetType ?? '') !== (spec.targetType || 'Ip')) {
        diffs.push({ field: `${label}.targetType`, expected: spec.targetType || 'Ip', actual: found.targetType ?? 'not set', severity: 'warning' })
      }
      if ((found.intervalInHours ?? 0) !== spec.intervalHours) {
        diffs.push({ field: `${label}.intervalInHours`, expected: spec.intervalHours, actual: found.intervalInHours ?? 'not set', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({ field: 'mde', expected: 'reachable', actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`, severity: 'critical' })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
