import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGravityZoneClient } from '../../lib/gravityZone'
import { getPolicyDetails } from '../../lib/gravityZoneApi'
import { extractPolicyModuleStateSpecs } from './_shared'

/**
 * Detect drift for policy module states: confirms each declared policyId
 * still exists (policies.getPolicyDetails). Field-level drift on the
 * module states themselves is NOT reported — GravityZone documents no
 * confirmed mapping from getPolicyDetails' read-back shape to
 * setPolicyModulesState's write-side "settings" input, so this app cannot
 * honestly compare the two without risking a false diff. See README.md
 * "Known limitations".
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildGravityZoneClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractPolicyModuleStateSpecs(ctx.deployedConfig).filter((s) => s.policyId)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  for (const spec of specs) {
    const details = await getPolicyDetails(client, spec.policyId)
    if (!details) {
      diffs.push({ field: spec.policyId, expected: 'present', actual: 'missing', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
