import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSysdigClient } from '../../lib/sysdigApi'
import { conditionOf, findRuleByName, normalizeEnabled, normalizePriority } from './_shared'

/**
 * Drift for Falco rules: compare the presence + condition / output / priority /
 * source we declare against the live rule in Sysdig Secure. Best-effort — a rule
 * that can't be read (transient error) is skipped rather than raising false
 * drift. Read-only: GET /api/secure/rules/groups per rule.
 *
 * An enabled rule that is missing, or whose body diverged, is drift. A disabled
 * rule that still exists in the custom library is drift (this app removes it).
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
      live = findRuleByName(await client.listRulesByName(name), name)
    } catch {
      continue // best-effort: can't read this rule, no drift asserted
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

    const expectedOutput = String(item.fields.output ?? '').trim()
    const actualOutput = String(live.details?.output ?? '').trim()
    if (expectedOutput && actualOutput && expectedOutput !== actualOutput) {
      diffs.push({ field: `${name}.output`, expected: expectedOutput, actual: actualOutput, severity: 'warning' })
    }

    const expectedPriority = normalizePriority(item.fields.priority)
    const actualPriority = normalizePriority(live.details?.priority)
    if (expectedPriority && actualPriority && expectedPriority !== actualPriority) {
      diffs.push({ field: `${name}.priority`, expected: expectedPriority, actual: actualPriority, severity: 'warning' })
    }

    const expectedSource = String(item.fields.source ?? '').trim()
    const actualSource = String(live.details?.source ?? '').trim()
    if (expectedSource && actualSource && expectedSource !== actualSource) {
      diffs.push({ field: `${name}.source`, expected: expectedSource, actual: actualSource, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
