import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildEsUrl, buildAuthHeader, getJson } from '../../lib/soConsole'

/**
 * Drift for ILM policies: compare the min_age / max_age (and optional max primary
 * shard size) we declare against the live policy on Elasticsearch. Best-effort —
 * a policy that can't be read (missing / transient error) is skipped rather than
 * raising false drift.
 */
interface IlmGetResponse {
  [name: string]: { policy?: Record<string, unknown> } | undefined
}

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const esUrl = buildEsUrl(component, connectivity, connectivityProvider)
  const auth = buildAuthHeader(credential)

  for (const item of items) {
    const policyName = String(item.fields.policyName ?? '').trim()
    if (!policyName) continue

    let live: Record<string, unknown> | null = null
    try {
      const res = await getJson<IlmGetResponse>(`${esUrl}/_ilm/policy/${encodeURIComponent(policyName)}`, auth)
      live = res[policyName]?.policy ?? null
    } catch {
      continue // best-effort: skip a policy we can't read
    }
    if (!live) continue

    const hotMaxAgeDays = Number(item.fields.hotMaxAgeDays)
    const deleteMinAgeDays = Number(item.fields.deleteMinAgeDays)
    const shardRaw = item.fields.hotMaxPrimaryShardSizeGb
    const hasShard = shardRaw !== undefined && shardRaw !== null && String(shardRaw).trim() !== ''

    const expectedHotMaxAge = `${hotMaxAgeDays}d`
    const liveHotMaxAge = get(live, ['phases', 'hot', 'actions', 'rollover', 'max_age'])
    if (liveHotMaxAge !== expectedHotMaxAge) {
      diffs.push({ field: `${policyName}.hotMaxAge`, expected: expectedHotMaxAge, actual: liveHotMaxAge ?? null, severity: 'warning' })
    }

    const expectedDeleteMinAge = `${deleteMinAgeDays}d`
    const liveDeleteMinAge = get(live, ['phases', 'delete', 'min_age'])
    if (liveDeleteMinAge !== expectedDeleteMinAge) {
      diffs.push({ field: `${policyName}.deleteMinAge`, expected: expectedDeleteMinAge, actual: liveDeleteMinAge ?? null, severity: 'warning' })
    }

    if (hasShard) {
      const expectedShard = `${Number(shardRaw)}gb`
      const liveShard = get(live, ['phases', 'hot', 'actions', 'rollover', 'max_primary_shard_size'])
      if (liveShard !== expectedShard) {
        diffs.push({ field: `${policyName}.hotMaxPrimaryShardSize`, expected: expectedShard, actual: liveShard ?? null, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
