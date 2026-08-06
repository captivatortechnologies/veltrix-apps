import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getManagedEndpointDetails } from '../../lib/gravityZoneApi'
import { extractPolicyAssignmentSpecs } from './_shared'

/**
 * Detect drift for policy assignments: GravityZone exposes no confirmed
 * method to read "the current policy assignment for endpoint X" (see
 * rollback.ts and README.md "Known limitations"), so this checks only that
 * every declared target endpoint id still exists (network.getManagedEndpointDetails)
 * — a missing target is reported as a warning (the assignment can no longer
 * apply to it), not critical, since the assignment itself is not a
 * persisted object this app can confirm is "wrong".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicyAssignmentSpecs(ctx.deployedConfig).filter((s) => s.assignmentName)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const missing: string[] = []
    for (const targetId of spec.targetIds) {
      const details = await getManagedEndpointDetails(client, targetId)
      if (!details) missing.push(targetId)
    }
    if (missing.length > 0) {
      diffs.push({
        field: `${spec.assignmentName}.targetIds`,
        expected: spec.targetIds,
        actual: `missing: ${missing.join(', ')}`,
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
