import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient } from '../../lib/elastic'
import { attachDriftActor, veltrixActorLogins } from '../lib/elasticAudit'
import { findItems, findList } from './deploy'
import { extractListSpecs, itemIdOf, parseItemsArray } from './validate'

/**
 * Detect drift between the deployed exception-list configuration and the live
 * Kibana state. Re-finds each declared list by list_id and diffs the list
 * container fields (name / description) plus each declared item's entries,
 * matched by item_id. Only authored fields are compared — the server-managed
 * fields Kibana injects (id, tie_breaker_id, _version, created_*, updated_*) are
 * never read, so its bookkeeping cannot register as drift. Items authored
 * outside this config are NOT reported — only the declared items are compared
 * (this config does not own the rest).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  // Connection identity our own deploys are recorded under — excluded so
  // attribution reflects the MANUAL change, not a Veltrix deploy.
  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  const specs = extractListSpecs(ctx.deployedConfig).filter((s) => s.listId && s.name)

  for (const spec of specs) {
    const label = spec.listId
    try {
      const live = await findList(client, spec.listId, spec.namespaceType)
      if (!live) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      // Attribute the LIST container's diffs to whoever last changed the list.
      const listBefore = diffs.length

      // List container fields.
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

      // Items — compare each declared item's entries by item_id.
      const desired = spec.itemsJson ? parseItemsArray(spec.itemsJson) ?? [] : []
      if (desired.length > 0) {
        const liveItems = await findItems(client, spec.listId, spec.namespaceType)
        const liveById = new Map(liveItems.filter((i) => i.item_id).map((i) => [i.item_id as string, i]))

        for (const raw of desired) {
          const itemId = itemIdOf(raw)
          if (!itemId) continue
          const liveItem = liveById.get(itemId)
          if (!liveItem) {
            diffs.push({
              field: `${label}.items.${itemId}`,
              expected: 'exists',
              actual: 'missing',
              severity: 'critical',
            })
            continue
          }
          // Each item is its own object — attribute its diffs to whoever last
          // changed THAT item (updated_by / updated_at on the live item).
          const itemBefore = diffs.length
          const expectedEntries = stableStringify(Array.isArray(raw.entries) ? raw.entries : [])
          const actualEntries = stableStringify(Array.isArray(liveItem.entries) ? liveItem.entries : [])
          if (expectedEntries !== actualEntries) {
            diffs.push({
              field: `${label}.items.${itemId}.entries`,
              expected: expectedEntries,
              actual: actualEntries,
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
