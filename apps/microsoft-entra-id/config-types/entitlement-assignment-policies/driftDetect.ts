import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAssignmentPolicySpecs, parseObject, type LiveAssignmentPolicy } from './validate'

const BASE = '/identityGovernance/entitlementManagement/assignmentPolicies'
const SELECT = '?$select=id,displayName,description,allowedTargetScope,expiration,requestorSettings,requestApprovalSettings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAssignmentPolicySpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAssignmentPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.allowedTargetScope !== (live.allowedTargetScope ?? '')) {
      diffs.push({
        field: `${spec.name}.allowedTargetScope`,
        expected: spec.allowedTargetScope,
        actual: live.allowedTargetScope ?? '',
        severity: 'warning',
      })
    }
    const fields: Array<['expiration' | 'requestorSettings' | 'requestApprovalSettings', unknown]> = [
      ['expiration', live.expiration],
      ['requestorSettings', live.requestorSettings],
      ['requestApprovalSettings', live.requestApprovalSettings],
    ]
    for (const [field, liveVal] of fields) {
      const want = canonical(parseObject(spec[field]) ?? {})
      const actual = canonical(liveVal ?? {})
      if (want !== actual) {
        diffs.push({ field: `${spec.name}.${field}`, expected: want, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
