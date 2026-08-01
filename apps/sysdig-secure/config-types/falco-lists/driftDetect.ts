import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { findListByName, itemsOf, normalizeEnabled, splitItems } from './_shared'

/**
 * Drift for Falco lists: compare the presence + item set we declare against the
 * live list in Sysdig Secure. Best-effort — a list that can't be read (transient
 * error) is skipped rather than raising false drift. Read-only:
 * GET /api/secure/falco/lists/groups per list.
 *
 * An enabled list that is missing, or whose items diverged, is drift. A disabled
 * list that still exists is drift (this app removes it).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildSysdigClient(ctx.component?.hostname ?? null, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const enabled = normalizeEnabled(item.fields.enabled)

    let live
    try {
      live = findListByName(await client.listFalcoListsByName(name), name)
    } catch {
      continue // best-effort: can't read this list, no drift asserted
    }

    if (!enabled) {
      if (live) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedItems = [...splitItems(item.fields.items)].sort()
    const actualItems = itemsOf(live)
    if (expectedItems.join('|') !== actualItems.join('|')) {
      diffs.push({ field: `${name}.items`, expected: expectedItems.join(', '), actual: actualItems.join(', '), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
