import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractResourceListSpecs, type LiveResourceList } from './validate'

const BASE = '/v1/resource_list'

type Diffs = DriftResult['diffs']

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k])
    return out
  }
  return v
}

function canonicalJson(v: unknown): string {
  return JSON.stringify(canonical(v))
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractResourceListSpecs(ctx.deployedConfig).filter((s) => s.name && !s.membersError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveResourceList[]>(res.body) ?? []
  const liveByName = new Map(live.filter((rl) => rl.name).map((rl) => [rl.name!.toLowerCase(), rl]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const rl = liveByName.get(spec.name.toLowerCase())
    if (!rl) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((rl.resourceListType ?? '') !== spec.resourceListType) {
      diffs.push({ field: `${spec.name}.resourceListType`, expected: spec.resourceListType, actual: rl.resourceListType ?? '', severity: 'warning' })
    }
    if (((rl.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (rl.description ?? '') as string, severity: 'warning' })
    }
    if (canonicalJson(rl.members ?? []) !== canonicalJson(spec.members)) {
      diffs.push({ field: `${spec.name}.members`, expected: 'declared members', actual: 'live members differ', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
