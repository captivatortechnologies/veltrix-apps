import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractAccountGroupSpecs, type LiveAccountGroup } from './validate'

const BASE = '/cloud/group'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractAccountGroupSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAccountGroup[]>(res.body) ?? []
  const liveByName = new Map(live.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const g = liveByName.get(spec.name.toLowerCase())
    if (!g) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((g.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: g.description ?? '', severity: 'warning' })
    }
    if (sortedJson(g.accountIds ?? []) !== sortedJson(spec.accountIds)) {
      diffs.push({ field: `${spec.name}.accountIds`, expected: [...spec.accountIds].sort(), actual: [...(g.accountIds ?? [])].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
