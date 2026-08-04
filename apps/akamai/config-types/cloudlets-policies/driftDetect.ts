import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson } from '../../lib/akamaiApi'
import {
  contentFromResponse,
  findPolicy,
  latestVersion,
  policiesPath,
  policyVersionPath,
  policyVersionsPath,
  readPolicyFields,
  sameMatchRules,
  type CloudletPolicy,
  type CloudletPolicyVersion,
} from './_shared'

/**
 * Drift for Cloudlets policies: compare the groupId/description we declare
 * against the live policy (matched by name), and the latest version's
 * matchRules/description against what's declared. Best-effort — a policy that
 * can't be matched or whose versions can't be read is skipped rather than
 * raising false drift. Read-only: GET /cloudlets/v3/policies[/{id}/versions[/{version}]].
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  let live: CloudletPolicy[]
  try {
    const res = await client.request('GET', policiesPath, { query: { size: 1000 } })
    if (!res.ok) return { hasDrift: false, diffs }
    live = contentFromResponse<CloudletPolicy>(parseJson<unknown>(res.body))
  } catch {
    return { hasDrift: false, diffs }
  }

  for (const item of items) {
    const fields = readPolicyFields(item.fields)
    const match = findPolicy(live, fields.name)
    if (!match?.id) continue

    const label = fields.name

    if ((match.groupId ?? null) !== fields.groupId) {
      diffs.push({ field: `${label}.groupId`, expected: fields.groupId, actual: match.groupId, severity: 'warning' })
    }
    if ((match.description ?? '') !== fields.description) {
      diffs.push({ field: `${label}.description`, expected: fields.description, actual: match.description, severity: 'info' })
    }

    try {
      const vRes = await client.request('GET', policyVersionsPath(match.id), { query: { size: 1000 } })
      if (!vRes.ok) continue
      const versions = contentFromResponse<CloudletPolicyVersion>(parseJson<unknown>(vRes.body))
      const latest = latestVersion(versions)
      if (!latest?.version) {
        diffs.push({ field: `${label}.matchRules`, expected: `${fields.matchRules.length} rule(s)`, actual: 'no version yet', severity: 'warning' })
        continue
      }
      const fullRes = await client.request('GET', policyVersionPath(match.id, latest.version))
      if (!fullRes.ok) continue
      const full = parseJson<CloudletPolicyVersion>(fullRes.body)
      const liveRules = Array.isArray(full?.matchRules) ? full!.matchRules! : []
      if (!sameMatchRules(liveRules, fields.matchRules)) {
        diffs.push({
          field: `${label}.matchRules`,
          expected: `${fields.matchRules.length} rule(s)`,
          actual: `${liveRules.length} rule(s) (version ${latest.version})`,
          severity: 'warning',
        })
      }
    } catch {
      continue
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
