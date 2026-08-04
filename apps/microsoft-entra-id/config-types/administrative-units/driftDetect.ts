import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAdministrativeUnitSpecs, graphVisibility, type LiveAdministrativeUnit } from './validate'
import { buildDeviceNameToId, buildGroupNameToId, buildUserNameToId, resolveAcrossMapsMany } from '../lib/nameMaps'

const BASE = '/directory/administrativeUnits'
const SELECT = '?$select=id,displayName,description,visibility,membershipType'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAdministrativeUnitSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveAdministrativeUnit>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((u) => u.displayName).map((u) => [u.displayName!.toLowerCase(), u])
  )

  const [userMap, groupMap, deviceMap] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildDeviceNameToId(client),
  ])

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByName.get(spec.name.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const wantDescription = spec.description || ''
    const liveDescription = (live.description ?? '') as string
    if (liveDescription !== wantDescription) {
      diffs.push({
        field: `${spec.name}.description`,
        expected: wantDescription,
        actual: liveDescription,
        severity: 'warning',
      })
    }
    const wantVisibility = graphVisibility(spec) ?? 'public'
    const liveVisibility = (live.visibility ?? 'public') as string
    if (liveVisibility !== wantVisibility) {
      diffs.push({
        field: `${spec.name}.visibility`,
        expected: wantVisibility,
        actual: liveVisibility,
        severity: 'warning',
      })
    }

    if (!live.id) continue
    const memberResolution = resolveAcrossMapsMany(spec.members, [userMap, groupMap, deviceMap])
    if (memberResolution.missing.length) {
      diffs.push({
        field: `${spec.name}.members`,
        expected: 'resolvable',
        actual: `unknown member(s): ${memberResolution.missing.join(', ')}`,
        severity: 'critical',
      })
      continue
    }
    const liveMembers = await client.getAll<{ id?: string }>(`${BASE}/${live.id}/members?$select=id`)
    if (!liveMembers.ok) continue
    const liveIds = liveMembers.items.map((m) => m.id).filter((id): id is string => Boolean(id))
    // A declared member missing from the live set is what matters for
    // "is the canvas applied" — an EXTRA live member (never declared, or
    // pre-existing) is expected and not itself drift, matching the
    // deploy-time "never touch what we didn't add" rule.
    const missingLive = memberResolution.ids.filter((id) => !liveIds.includes(id))
    if (missingLive.length) {
      diffs.push({
        field: `${spec.name}.members`,
        expected: sortedJson(memberResolution.ids),
        actual: sortedJson(liveIds),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
