import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractLoginIpAllowSpecs, type LiveLoginIpAllow } from './validate'

const BASE = '/ip_allow_list_login'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractLoginIpAllowSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveLoginIpAllow[]>(res.body) ?? []
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((l.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (l.description ?? '') as string, severity: 'warning' })
    }
    if (sortedJson(l.cidr ?? []) !== sortedJson(spec.cidr)) {
      diffs.push({ field: `${spec.name}.cidr`, expected: [...spec.cidr].sort(), actual: [...(l.cidr ?? [])].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
