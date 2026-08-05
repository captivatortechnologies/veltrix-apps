import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSophosClient } from '../../lib/sophosCentral'
import { listAllowedItems, type SophosAllowedItem } from '../../lib/sophosApi'
import { allowedItemKey, allowedItemPropertiesMatch, extractAllowedItemSpecs, liveAllowedItemValue } from './_shared'

/**
 * Detect drift for allowed items: for each declared (type, value) pair, find
 * the live item and compare properties (fileName) and comment. A declared
 * item that no longer exists is critical drift; a changed comment or
 * property is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildSophosClient(ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const specs = extractAllowedItemSpecs(ctx.deployedConfig).filter((s) => s.type && s.value)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  let live: SophosAllowedItem[]
  try {
    live = await listAllowedItems(client)
  } catch {
    return { hasDrift: false, diffs: [] }
  }
  const liveByKey = new Map(
    live
      .map((i) => [i.type && liveAllowedItemValue(i) ? allowedItemKey(i.type, liveAllowedItemValue(i)!) : null, i] as const)
      .filter((entry): entry is [string, SophosAllowedItem] => entry[0] !== null),
  )

  for (const spec of specs) {
    const label = `${spec.type}:${spec.value}`
    const match = liveByKey.get(allowedItemKey(spec.type, spec.value))
    if (!match) {
      diffs.push({ field: label, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }
    if (!allowedItemPropertiesMatch(spec, match)) {
      diffs.push({ field: `${label}.fileName`, expected: spec.fileName, actual: match.properties?.fileName ?? '', severity: 'warning' })
    }
    if ((match.comment ?? '') !== spec.comment) {
      diffs.push({ field: `${label}.comment`, expected: spec.comment, actual: match.comment ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
