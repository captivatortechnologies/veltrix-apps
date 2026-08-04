import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { findItems, findList } from './deploy'
import { extractListSpecs, itemIdOf, parseItemsArray } from './validate'

/**
 * Detect drift between the deployed value-list configuration and the live
 * Kibana state. Re-finds each declared list by id and diffs the list
 * container fields (name / description) plus each declared item's value,
 * matched by item id. Only authored fields are compared — server-managed
 * fields (tie_breaker_id, _version, created_*) are never read. Items authored
 * outside this config are NOT reported — only the declared items are compared.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const excludeActorLogins = veltrixActorLogins(ctx.credential)
  const specs = extractListSpecs(ctx.deployedConfig).filter((s) => s.id && s.name)

  for (const spec of specs) {
    const label = spec.id
    try {
      const live = await findList(client, spec.id)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      const listBefore = diffs.length

      const liveName = typeof live.name === 'string' ? live.name : ''
      if (spec.name !== liveName) {
        diffs.push({ field: `${label}.name`, expected: spec.name, actual: liveName || 'not set', severity: 'info' })
      }
      const liveDescription = typeof live.description === 'string' ? live.description.trim() : ''
      if ((spec.description ?? '') !== liveDescription) {
        diffs.push({
          field: `${label}.description`,
          expected: spec.description ?? 'not set',
          actual: liveDescription || 'not set',
          severity: 'info',
        })
      }

      // Who last changed the list container (name / description) + when.
      attachDriftActor(diffs.slice(listBefore), live, { excludeActorLogins })

      const desired = spec.itemsJson ? (parseItemsArray(spec.itemsJson) ?? []) : []
      if (desired.length > 0) {
        const liveItems = await findItems(client, spec.id)
        const liveById = new Map(liveItems.filter((i) => i.id).map((i) => [i.id as string, i]))

        for (const raw of desired) {
          const itemId = itemIdOf(raw)
          if (!itemId) continue
          const liveItem = liveById.get(itemId)
          if (!liveItem) {
            diffs.push({ field: `${label}.items.${itemId}`, expected: 'exists', actual: 'missing', severity: 'critical' })
            continue
          }
          const itemBefore = diffs.length
          const expectedValue = stableStringify(raw.value)
          const actualValue = stableStringify(liveItem.value)
          if (expectedValue !== actualValue) {
            diffs.push({
              field: `${label}.items.${itemId}.value`,
              expected: expectedValue,
              actual: actualValue,
              severity: 'warning',
            })
          }
          attachDriftActor(diffs.slice(itemBefore), liveItem, { excludeActorLogins })
        }
      }
    } catch (error) {
      diffs.push({
        field: label,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}

/** Deterministic JSON stringify with recursively sorted object keys. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
