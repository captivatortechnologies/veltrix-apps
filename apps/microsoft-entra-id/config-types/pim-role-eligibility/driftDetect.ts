import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import {
  eligibilityKey,
  eligibilityLabel,
  expirationDiff,
  extractEligibilitySpecs,
  type LiveEligibilitySchedule,
} from './validate'

const SCHEDULES = '/roleManagement/directory/roleEligibilitySchedules'
const SCHEDULE_SELECT = '?$select=id,principalId,roleDefinitionId,directoryScopeId,status,scheduleInfo,createdDateTime,modifiedDateTime'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractEligibilitySpecs(ctx.deployedConfig).filter((s) => s.principalId && s.roleDefinitionId)

  const listed = await client.getAll<LiveEligibilitySchedule>(`${SCHEDULES}${SCHEDULE_SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const byKey = new Map<string, LiveEligibilitySchedule>()
  for (const s of listed.items) {
    if (s.principalId && s.roleDefinitionId) {
      byKey.set(eligibilityKey(s.principalId, s.roleDefinitionId, s.directoryScopeId ?? '/'), s)
    }
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const label = eligibilityLabel(spec)
    const live = byKey.get(eligibilityKey(spec.principalId, spec.roleDefinitionId, spec.directoryScopeId))

    // A declared eligibility missing from the applied schedules is critical —
    // unless the listing was truncated, where absence can't be proven.
    if (!live) {
      if (listed.truncated) continue
      diffs.push({ field: label, expected: 'eligible', actual: 'absent', severity: 'critical' })
      continue
    }

    // The eligibility window (expiration) drifting is a warning.
    const diff = expirationDiff(spec, live)
    if (diff) {
      diffs.push({ field: `${label}.expiration`, expected: diff.expected, actual: diff.actual, severity: 'warning' })
    }
  }

  if (listed.truncated) {
    diffs.push({
      field: '(eligibility listing)',
      expected: 'complete',
      actual: `truncated at ${byKey.size}+ schedules — absence of declared eligibilities not verified`,
      severity: 'info',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
