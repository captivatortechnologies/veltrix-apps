import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractRoleSpecs, type LiveRole } from './validate'

const BASE = '/user/role'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractRoleSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveRole[]>(res.body) ?? []
  const liveByName = new Map(live.filter((r) => r.name).map((r) => [r.name!.toLowerCase(), r]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const r = liveByName.get(spec.name.toLowerCase())
    if (!r) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((r.roleType ?? '') !== spec.roleType) {
      diffs.push({ field: `${spec.name}.roleType`, expected: spec.roleType, actual: r.roleType ?? '', severity: 'warning' })
    }
    if (((r.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (r.description ?? '') as string, severity: 'warning' })
    }
    if (sortedJson(r.accountGroupIds ?? []) !== sortedJson(spec.accountGroupIds)) {
      diffs.push({ field: `${spec.name}.accountGroupIds`, expected: [...spec.accountGroupIds].sort(), actual: [...(r.accountGroupIds ?? [])].sort(), severity: 'warning' })
    }
    if (sortedJson(r.resourceListIds ?? []) !== sortedJson(spec.resourceListIds)) {
      diffs.push({ field: `${spec.name}.resourceListIds`, expected: [...spec.resourceListIds].sort(), actual: [...(r.resourceListIds ?? [])].sort(), severity: 'warning' })
    }
    if ((r.restrictDismissalAccess ?? false) !== spec.restrictDismissalAccess) {
      diffs.push({ field: `${spec.name}.restrictDismissalAccess`, expected: String(spec.restrictDismissalAccess), actual: String(r.restrictDismissalAccess ?? false), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
