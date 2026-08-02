import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, getJson } from '../../lib/graylogApi'
import { asString, toInt } from '../../lib/coerce'
import {
  indexSetsFromList,
  findIndexSet,
  buildRotationStrategy,
  buildRetentionStrategy,
  normalizeRotationKind,
  normalizeRetentionKind,
  INDEX_SET_DEFAULTS,
  type StrategyConfig,
} from './_shared'

/**
 * Drift for index sets: compare index_prefix, shards, replicas and the rotation /
 * retention strategy (class + params) we declare against the live index set in
 * Graylog. Best-effort, read-only: GET /api/system/indices/index_sets.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live
  try {
    live = indexSetsFromList(await getJson<unknown>(`${base}/api/system/indices/index_sets`, headers))
  } catch {
    return { hasDrift: false, diffs }
  }

  const compareStrategy = (title: string, label: string, expected: StrategyConfig, actual: StrategyConfig | undefined) => {
    for (const key of Object.keys(expected)) {
      const exp = asString(expected[key])
      const act = asString(actual?.[key])
      if (exp !== act) {
        diffs.push({ field: `${title}.${label}.${key}`, expected: exp, actual: act, severity: 'warning' })
      }
    }
  }

  for (const item of items) {
    const title = asString(item.fields.title)
    const match = findIndexSet(live, title)
    if (!match) continue

    const expectedPrefix = asString(item.fields.index_prefix)
    const actualPrefix = asString(match.index_prefix)
    if (expectedPrefix !== actualPrefix) {
      diffs.push({ field: `${title}.index_prefix`, expected: expectedPrefix, actual: actualPrefix, severity: 'warning' })
    }

    const expectedShards = toInt(item.fields.shards, INDEX_SET_DEFAULTS.shards)
    const actualShards = toInt(match.shards, INDEX_SET_DEFAULTS.shards)
    if (expectedShards !== actualShards) {
      diffs.push({ field: `${title}.shards`, expected: expectedShards, actual: actualShards, severity: 'info' })
    }

    const expectedReplicas = toInt(item.fields.replicas, INDEX_SET_DEFAULTS.replicas)
    const actualReplicas = toInt(match.replicas, INDEX_SET_DEFAULTS.replicas)
    if (expectedReplicas !== actualReplicas) {
      diffs.push({ field: `${title}.replicas`, expected: expectedReplicas, actual: actualReplicas, severity: 'info' })
    }

    const rotation = buildRotationStrategy(normalizeRotationKind(item.fields.rotation_strategy), item.fields.rotation_value)
    compareStrategy(title, 'rotation_strategy', rotation.config, match.rotation_strategy)

    const retention = buildRetentionStrategy(normalizeRetentionKind(item.fields.retention_strategy), item.fields.retention_max_indices)
    compareStrategy(title, 'retention_strategy', retention.config, match.retention_strategy)
  }

  return { hasDrift: diffs.length > 0, diffs }
}
