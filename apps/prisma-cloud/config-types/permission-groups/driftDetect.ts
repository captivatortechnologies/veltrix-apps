import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractPermissionGroupSpecs, type LivePermissionGroup } from './validate'

const BASE = '/authz/v1/permission_group'

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

  const specs = extractPermissionGroupSpecs(ctx.deployedConfig).filter((s) => s.name && !s.featuresError)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = parseJson<LivePermissionGroup[]>(res.body) ?? []
  const liveByName = new Map(live.filter((g) => g.name).map((g) => [g.name!.toLowerCase(), g]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const g = liveByName.get(spec.name.toLowerCase())
    if (!g) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((g.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (g.description ?? '') as string, severity: 'warning' })
    }
    if ((g.acceptAccountGroups ?? false) !== spec.acceptAccountGroups) {
      diffs.push({ field: `${spec.name}.acceptAccountGroups`, expected: String(spec.acceptAccountGroups), actual: String(g.acceptAccountGroups ?? false), severity: 'warning' })
    }
    if ((g.acceptResourceLists ?? false) !== spec.acceptResourceLists) {
      diffs.push({ field: `${spec.name}.acceptResourceLists`, expected: String(spec.acceptResourceLists), actual: String(g.acceptResourceLists ?? false), severity: 'warning' })
    }
    if ((g.acceptCodeRepositories ?? false) !== spec.acceptCodeRepositories) {
      diffs.push({ field: `${spec.name}.acceptCodeRepositories`, expected: String(spec.acceptCodeRepositories), actual: String(g.acceptCodeRepositories ?? false), severity: 'warning' })
    }
    if (canonicalJson(g.features ?? []) !== canonicalJson(spec.features)) {
      diffs.push({ field: `${spec.name}.features`, expected: 'declared features', actual: 'live features differ', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
