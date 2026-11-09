import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { getPolicyAccount, getPolicyByName, listActiveExceptions } from '../../lib/db'
import { diffFields, driftResult, missingDiff, sameValue, unreadableDrift } from '../lib/drift'
import { evaluatePolicyItem } from '../lib/policyItem'
import { itemsOf } from '../lib/readers'
import { toPolicyException } from '../lib/results'
import { resolveStore } from '../lib/store'
import { policyTargetsComponent } from '../lib/targets'

/**
 * The canvas is the source of truth: a stored policy whose model, compiled
 * YAML, account registration or regions differ from what the canvas would
 * deploy now is drift. The store is directly readable, so this always checks
 * when the store is available.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const store = resolveStore(ctx)
  if (!store) return unreadableDrift()

  const now = new Date()
  const diffs: DriftDiff[] = []
  for (const canvasItem of itemsOf(ctx.deployedConfig)) {
    const first = evaluatePolicyItem(canvasItem)
    const name = first.item.model.name
    if (typeof name !== 'string' || name === '' || !first.validated) continue
    if (!policyTargetsComponent(first.validated, ctx.component)) continue

    const stored = await getPolicyByName(store.db, store.customerId, name)
    if (!stored) {
      diffs.push(missingDiff(name, 'policy'))
      continue
    }
    diffs.push(...diffFields(name, first.validated as unknown as Record<string, unknown>, stored.model as unknown as Record<string, unknown>))

    const exceptions = (await listActiveExceptions(store.db, store.customerId, name, now)).map(toPolicyException)
    const expected = evaluatePolicyItem(canvasItem, { exceptions, now })
    const expectedYaml = expected.ok ? expected.compile.yaml : null
    if (expectedYaml !== stored.compiledYaml) {
      diffs.push({
        field: `${name}.compiledYaml`,
        expected: expectedYaml === null ? 'not compilable' : 'current',
        actual: stored.compiledYaml === null ? 'not compiled' : 'stale',
        severity: 'warning',
      })
    }

    const account = await getPolicyAccount(store.db, store.customerId, stored.id, ctx.component.id)
    if (!account) {
      diffs.push(missingDiff(`${name}.account`, `registration for ${ctx.component.hostname}`))
    } else if (!sameValue(account.regions, expected.item.regions)) {
      diffs.push({ field: `${name}.regions`, expected: expected.item.regions, actual: account.regions, severity: 'warning' })
    }
  }
  return driftResult(diffs)
}
