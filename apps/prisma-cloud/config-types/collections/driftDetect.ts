import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildPcClient, parseJson, readPcSettings, resolvePcCredential } from '../../lib/prismacloud'
import { extractCollectionSpecs, type LiveCollection } from './validate'

const BASE = '/entitlement/api/v1/collection'

type Diffs = DriftResult['diffs']

function sortedJson(v: string[]): string {
  return JSON.stringify([...v].sort())
}

function asCollectionList(body: string): LiveCollection[] {
  const parsed = parseJson<unknown>(body)
  if (Array.isArray(parsed)) return parsed as LiveCollection[]
  if (parsed && typeof parsed === 'object') {
    for (const v of Object.values(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) return v as LiveCollection[]
    }
  }
  return []
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readPcSettings(ctx.settings)
  const cred = resolvePcCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildPcClient(cred, settings)

  const specs = extractCollectionSpecs(ctx.deployedConfig).filter((s) => s.name)
  const res = await client.get(BASE)
  if (!res.ok) return { hasDrift: false, diffs: [] }
  const live = asCollectionList(res.body)
  const liveByName = new Map(live.filter((c) => c.name).map((c) => [c.name!.toLowerCase(), c]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const c = liveByName.get(spec.name.toLowerCase())
    if (!c) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (((c.description ?? '') as string) !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: (c.description ?? '') as string, severity: 'warning' })
    }
    const ag = c.assetGroups ?? {}
    if (sortedJson(ag.accountGroupIds ?? []) !== sortedJson(spec.assetGroups.accountGroupIds)) {
      diffs.push({ field: `${spec.name}.accountGroupIds`, expected: [...spec.assetGroups.accountGroupIds].sort(), actual: [...(ag.accountGroupIds ?? [])].sort(), severity: 'warning' })
    }
    if (sortedJson(ag.accountIds ?? []) !== sortedJson(spec.assetGroups.accountIds)) {
      diffs.push({ field: `${spec.name}.accountIds`, expected: [...spec.assetGroups.accountIds].sort(), actual: [...(ag.accountIds ?? [])].sort(), severity: 'warning' })
    }
    if (sortedJson(ag.repositoryIds ?? []) !== sortedJson(spec.assetGroups.repositoryIds)) {
      diffs.push({ field: `${spec.name}.repositoryIds`, expected: [...spec.assetGroups.repositoryIds].sort(), actual: [...(ag.repositoryIds ?? [])].sort(), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
