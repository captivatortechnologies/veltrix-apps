// unifiedRoleAssignment is immutable, so there is no field-level drift — the only
// drift is a declared assignment tuple that is missing from the directory (critical).
import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { assignmentKey, extractRoleAssignmentSpecs, type LiveRoleAssignment } from './validate'

const BASE = '/roleManagement/directory/roleAssignments'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractRoleAssignmentSpecs(ctx.deployedConfig).filter((s) => s.roleDefinitionId && s.principalId)
  const listed = await client.getAll<LiveRoleAssignment>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByKey = new Map(listed.items.filter((a) => a.id).map((a) => [assignmentKey(a), a]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const key = assignmentKey(spec)
    if (!liveByKey.has(key)) {
      diffs.push({ field: spec.label || key, expected: 'present', actual: 'absent', severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
