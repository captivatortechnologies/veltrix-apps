import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractFlowVlanSpecs, vlanKey } from './validate'
import { listFlowVlans } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractFlowVlanSpecs(ctx.deployedConfig).filter((s) => s.label)
  const live = await listFlowVlans(client)
  const livePairs = new Set(live.map((v) => `${v.enterprise_vlan_id ?? 0}:${v.customer_vlan_id ?? 0}`))

  const diffs: Diffs = []
  for (const spec of specs) {
    if (!livePairs.has(vlanKey(spec))) {
      diffs.push({ field: spec.label, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
