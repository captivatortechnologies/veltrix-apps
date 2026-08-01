import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { conditionOf, findMacroByName, normalizeEnabled } from './_shared'

/**
 * Drift for Falco macros: compare the presence + condition we declare against
 * the live macro in Sysdig Secure. Best-effort — a macro that can't be read
 * (transient error) is skipped rather than raising false drift. Read-only:
 * GET /api/secure/falco/macros/groups per macro.
 *
 * An enabled macro that is missing, or whose condition diverged, is drift. A
 * disabled macro that still exists is drift (this app removes it).
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
      live = findMacroByName(await client.listFalcoMacrosByName(name), name)
    } catch {
      continue // best-effort: can't read this macro, no drift asserted
    }

    if (!enabled) {
      if (live) diffs.push({ field: `${name}.enabled`, expected: false, actual: true, severity: 'warning' })
      continue
    }

    if (!live) {
      diffs.push({ field: `${name}`, expected: 'present', actual: 'missing', severity: 'critical' })
      continue
    }

    const expectedCondition = String(item.fields.condition ?? '').trim()
    const actualCondition = conditionOf(live)
    if (expectedCondition && actualCondition && expectedCondition !== actualCondition) {
      diffs.push({ field: `${name}.condition`, expected: expectedCondition, actual: actualCondition, severity: 'critical' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
