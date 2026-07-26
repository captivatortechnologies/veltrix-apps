import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { effectiveNickname, extractGroupSpecs, type LiveGroup } from './validate'

const BASE = '/groups'
const SELECT = '?$select=id,displayName,description,mailNickname,mailEnabled,securityEnabled,groupTypes'

type Diffs = DriftResult['diffs']

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
  }

  return { hasDrift: diffs.length > 0, diffs }
}
