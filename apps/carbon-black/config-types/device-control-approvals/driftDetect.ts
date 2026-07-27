import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildCbClient, readCbSettings, resolveCbCredential } from '../../lib/carbonblack'
import { extractApprovalSpecs, liveNaturalKey, naturalKey, type LiveApproval } from './validate'
import { definitionEquals } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readCbSettings(ctx.settings)
  const cred = resolveCbCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildCbClient(cred, settings)
  const base = client.deviceControlPath('approvals')

  const specs = extractApprovalSpecs(ctx.deployedConfig).filter((s) => s.approvalName && (s.vendorId || s.productId || s.serialNumber))
  const listed = await client.searchAllAt<LiveApproval>(base, {})
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map<string, LiveApproval>()
  for (const a of listed.items) liveByKey.set(liveNaturalKey(a), a)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByKey.get(naturalKey(spec))
    if (!live) {
      diffs.push({ field: spec.approvalName, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      if ((live.approval_name ?? '') !== spec.approvalName) {
        diffs.push({ field: `${spec.approvalName}.approval_name`, expected: spec.approvalName, actual: live.approval_name ?? '', severity: 'warning' })
      }
      if ((live.notes ?? '') !== spec.notes) {
        diffs.push({ field: `${spec.approvalName}.notes`, expected: spec.notes, actual: live.notes ?? '', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
