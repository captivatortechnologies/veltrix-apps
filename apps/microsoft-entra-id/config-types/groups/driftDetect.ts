import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential, type GraphClient } from '../../lib/graph'
import { effectiveNickname, extractGroupSpecs, type LiveGroup } from './validate'
import { buildOwnerPrincipalNameMaps, resolveOwnerPrincipals } from '../lib/principals'
import { buildDeviceNameToId, buildGroupNameToId, buildServicePrincipalNameToId, buildUserNameToId, resolveAcrossMapsMany } from '../lib/nameMaps'
import { listRefIds } from '../lib/refReconcile'

const BASE = '/groups'
const SELECT = '?$select=id,displayName,description,mailNickname,mailEnabled,securityEnabled,groupTypes'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

async function buildMemberNameMaps(client: GraphClient) {
  const [user, group, device, servicePrincipal] = await Promise.all([
    buildUserNameToId(client),
    buildGroupNameToId(client),
    buildDeviceNameToId(client),
    buildServicePrincipalNameToId(client),
  ])
  return [user, group, device, servicePrincipal]
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  // Without a usable credential we can't read live state — assert no drift.
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const listed = await client.getAll<LiveGroup>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByName = new Map(
    listed.items.filter((g) => g.displayName).map((g) => [g.displayName!.toLowerCase(), g])
  )
  const ownerMaps = await buildOwnerPrincipalNameMaps(client)
  const memberMaps = await buildMemberNameMaps(client)

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
    const wantNick = effectiveNickname(spec)
    const liveNick = (live.mailNickname ?? '') as string
    if (liveNick !== wantNick) {
      diffs.push({
        field: `${spec.name}.mailNickname`,
        expected: wantNick,
        actual: liveNick,
        severity: 'warning',
      })
    }

    if (!live.id) continue

    const ownerResolution = resolveOwnerPrincipals(spec.owners, ownerMaps)
    if (ownerResolution.missing.length) {
      diffs.push({
        field: `${spec.name}.owners`,
        expected: 'resolvable',
        actual: `unknown owner(s): ${ownerResolution.missing.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const liveOwners = await listRefIds(client, `${BASE}/${live.id}`, 'owners')
      if (liveOwners.ok) {
        // A declared owner missing from the live set is what matters — an EXTRA
        // live owner (pre-existing, or added out-of-band) is expected and not
        // itself drift, matching the "never touch what we didn't add" deploy rule.
        const missingLive = ownerResolution.ids.filter((id) => !liveOwners.ids.has(id))
        if (missingLive.length) {
          diffs.push({
            field: `${spec.name}.owners`,
            expected: sortedJson(ownerResolution.ids),
            actual: sortedJson([...liveOwners.ids]),
            severity: 'warning',
          })
        }
      }
    }

    const memberResolution = resolveAcrossMapsMany(spec.members, memberMaps)
    if (memberResolution.missing.length) {
      diffs.push({
        field: `${spec.name}.members`,
        expected: 'resolvable',
        actual: `unknown member(s): ${memberResolution.missing.join(', ')}`,
        severity: 'critical',
      })
    } else {
      const liveMembers = await listRefIds(client, `${BASE}/${live.id}`, 'members')
      if (liveMembers.ok) {
        const missingLive = memberResolution.ids.filter((id) => !liveMembers.ids.has(id))
        if (missingLive.length) {
          diffs.push({
            field: `${spec.name}.members`,
            expected: sortedJson(memberResolution.ids),
            actual: sortedJson([...liveMembers.ids]),
            severity: 'warning',
          })
        }
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
