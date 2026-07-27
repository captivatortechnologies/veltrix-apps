import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractAccessReviewSpecs, parseArray, parseObject, type LiveAccessReview } from './validate'

const BASE = '/identityGovernance/accessReviews/definitions'
const SELECT = '?$select=id,displayName,descriptionForAdmins,scope,reviewers,settings'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAccessReviewSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAccessReview>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(listed.items.filter((d) => d.displayName).map((d) => [d.displayName!.toLowerCase(), d]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((spec.descriptionForAdmins || '') !== (live.descriptionForAdmins ?? '')) {
      diffs.push({
        field: `${spec.name}.descriptionForAdmins`,
        expected: spec.descriptionForAdmins || '',
        actual: live.descriptionForAdmins ?? '',
        severity: 'warning',
      })
    }
    const pairs: Array<[string, string, unknown]> = [
      ['scope', canonical(parseObject(spec.scope) ?? {}), live.scope],
      ['reviewers', canonical(parseArray(spec.reviewers) ?? []), live.reviewers],
      ['settings', canonical(parseObject(spec.settings) ?? {}), live.settings],
    ]
    for (const [field, want, liveVal] of pairs) {
      const actual = canonical(liveVal ?? (field === 'reviewers' ? [] : {}))
      if (want !== actual) diffs.push({ field: `${spec.name}.${field}`, expected: want, actual, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
