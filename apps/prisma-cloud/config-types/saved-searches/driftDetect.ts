import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractSavedSearchSpecs, type LiveSavedSearch } from './validate'

const BASE = '/search/history'

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

function asSavedList(body: string): LiveSavedSearch[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as LiveSavedSearch[]
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as LiveSavedSearch[]
    }
  }
  return []
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractSavedSearchSpecs(ctx.deployedConfig).filter((s) => s.name && !s.timeRangeError)
  const res = await client.get(`${BASE}?filter=saved`)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = asSavedList(res.body)
  const liveByName = new Map(live.filter((s) => s.name).map((s) => [s.name!.toLowerCase(), s]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const s = liveByName.get(spec.name.toLowerCase())
    if (!s) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((s.query ?? '') !== spec.query) {
      diffs.push({ field: `${spec.name}.query`, expected: spec.query, actual: s.query ?? '', severity: 'warning' })
    }
    if ((s.searchType ?? 'config') !== spec.searchType) {
      diffs.push({ field: `${spec.name}.searchType`, expected: spec.searchType, actual: s.searchType ?? 'config', severity: 'warning' })
    }
    if (spec.timeRange && canonicalJson(s.timeRange ?? {}) !== canonicalJson(spec.timeRange)) {
      diffs.push({ field: `${spec.name}.timeRange`, expected: 'declared time range', actual: 'live time range differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
