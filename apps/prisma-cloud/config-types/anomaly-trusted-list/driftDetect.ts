import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractAnomalyTrustedListSpecs, type LiveAnomalyTrustedList } from './validate'

const BASE = '/anomalies/trusted_list'

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

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractAnomalyTrustedListSpecs(ctx.deployedConfig).filter((s) => s.name && !s.entriesError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LiveAnomalyTrustedList[]>(res.body) ?? []
  const liveByName = new Map(live.filter((l) => l.name).map((l) => [l.name!.toLowerCase(), l]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const l = liveByName.get(spec.name.toLowerCase())
    if (!l) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((l.trustedListType ?? '') !== spec.trustedListType) {
      diffs.push({ field: `${spec.name}.trustedListType`, expected: spec.trustedListType, actual: l.trustedListType ?? '', severity: 'warning' })
    }
    if (sortedJson(l.applicablePolicies ?? []) !== sortedJson(spec.applicablePolicies)) {
      diffs.push({ field: `${spec.name}.applicablePolicies`, expected: [...spec.applicablePolicies].sort(), actual: [...(l.applicablePolicies ?? [])].sort(), severity: 'warning' })
    }
    if (canonicalJson(l.trustedListEntries ?? []) !== canonicalJson(spec.trustedListEntries)) {
      diffs.push({ field: `${spec.name}.trustedListEntries`, expected: 'declared entries', actual: 'live entries differ', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
