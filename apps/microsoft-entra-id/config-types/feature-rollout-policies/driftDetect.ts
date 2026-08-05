import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractFeatureRolloutSpecs, type LiveFeatureRolloutPolicy } from './validate'
import { buildGroupNameToId, resolveRefs } from '../lib/nameMaps'
import { listRefIds } from '../lib/refReconcile'

const BASE = '/policies/featureRolloutPolicies'
const SELECT = '?$select=id,displayName,feature,isEnabled,isAppliedToOrganization'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractFeatureRolloutSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveFeatureRolloutPolicy>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((p) => p.displayName).map((p) => [p.displayName!.toLowerCase(), p]),
  )
  const groupNameToId = await buildGroupNameToId(client)

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.isEnabled !== (live.isEnabled === true)) {
      diffs.push({
        field: `${spec.name}.isEnabled`,
        expected: String(spec.isEnabled),
        actual: String(live.isEnabled === true),
        severity: 'warning',
      })
    }
    if (spec.isAppliedToOrganization !== (live.isAppliedToOrganization === true)) {
      diffs.push({
        field: `${spec.name}.isAppliedToOrganization`,
        expected: String(spec.isAppliedToOrganization),
        actual: String(live.isAppliedToOrganization === true),
        severity: 'warning',
      })
    }
    if (spec.feature && live.feature && spec.feature !== live.feature) {
      diffs.push({
        field: `${spec.name}.feature`,
        expected: spec.feature,
        actual: live.feature,
        severity: 'warning',
      })
    }

    if (!live.id) continue
    const groupResolution = resolveRefs(spec.appliesTo, groupNameToId)
    if (groupResolution.missing.length) {
      diffs.push({
        field: `${spec.name}.appliesTo`,
        expected: 'resolvable',
        actual: `unknown group(s): ${groupResolution.missing.join(', ')}`,
        severity: 'critical',
      })
      continue
    }
    const liveAppliesTo = await listRefIds(client, `${BASE}/${live.id}`, 'appliesTo')
    if (!liveAppliesTo.ok) continue
    // A declared group missing from the live set is what matters — an EXTRA
    // live assignment (pre-existing, or added out-of-band) is expected and not
    // itself drift, matching the "never touch what we didn't add" deploy rule.
    const missingLive = groupResolution.ids.filter((id) => !liveAppliesTo.ids.has(id))
    if (missingLive.length) {
      diffs.push({
        field: `${spec.name}.appliesTo`,
        expected: sortedJson(groupResolution.ids),
        actual: sortedJson([...liveAppliesTo.ids]),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
