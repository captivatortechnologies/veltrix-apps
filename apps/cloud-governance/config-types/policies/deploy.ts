import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getPolicyAccount, getPolicyByName, listActiveExceptions, upsertPolicy, upsertPolicyAccount } from '../../lib/db'
import { evaluatePolicyItem } from '../lib/policyItem'
import { errorMessage, toPolicyException } from '../lib/results'
import { itemsOf } from '../lib/readers'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { PolicyRollbackData, PolicyRollbackEntry } from './_shared'

/**
 * Compiles each policy WITH the tenant's active exceptions, stores model and
 * compiled YAML, and registers the policy for this account. It never requests
 * a run: nothing executes until a preview or enforcement run is asked for.
 * A policy whose model is valid but does not compile is still stored, with
 * null compiled YAML, so the failure is visible and the old YAML is not kept.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }

  const now = new Date()
  const entries: PolicyRollbackEntry[] = []
  const deployed: string[] = []
  const failures: string[] = []
  const warnings: string[] = []

  try {
    for (const canvasItem of itemsOf(ctx.canvas)) {
      const first = evaluatePolicyItem(canvasItem)
      const name = typeof first.item.model.name === 'string' ? first.item.model.name : ''
      const label = name || canvasItem.name
      if (!first.validated) {
        failures.push(`${label}: ${first.errors.map((e) => e.message).join('; ')}`)
        continue
      }

      const exceptions = (await listActiveExceptions(store.db, store.customerId, name, now)).map(toPolicyException)
      const evaluation = evaluatePolicyItem(canvasItem, { exceptions, now })
      const existing = await getPolicyByName(store.db, store.customerId, name)
      const linked = existing ? await getPolicyAccount(store.db, store.customerId, existing.id, ctx.component.id) : null

      const policy = await upsertPolicy(store.db, store.customerId, {
        canvasId: ctx.canvas.canvasId,
        model: first.validated,
        compiledYaml: evaluation.ok ? evaluation.compile.yaml : null,
        actionClass: evaluation.ok ? evaluation.compile.actionClass : 'none',
        enforcement: first.validated.enforcement,
      })
      await upsertPolicyAccount(store.db, store.customerId, {
        policyId: policy.id,
        componentId: ctx.component.id,
        accountRef: ctx.component.hostname,
        regions: evaluation.item.regions,
      })
      entries.push({
        name,
        policyId: policy.id,
        existed: existing !== null,
        previousVersion: existing?.version ?? null,
        previousModel: existing?.model ?? null,
        previousCompiledYaml: existing?.compiledYaml ?? null,
        previousActionClass: existing?.actionClass ?? null,
        previousEnforcement: existing?.enforcement ?? null,
        previousCanvasId: existing?.canvasId ?? null,
        accountWasLinked: linked !== null,
      })

      if (evaluation.ok) deployed.push(name)
      else failures.push(`${name}: ${evaluation.errors.map((e) => e.message).join('; ')}`)
      warnings.push(...evaluation.warnings.map((w) => `${name}: ${w.message}`))
    }
  } catch (error) {
    failures.push(`Store error: ${errorMessage(error)}`)
  }

  const rollbackData: PolicyRollbackData = { componentId: ctx.component.id, policies: entries }
  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Compiled and registered ${deployed.length} policy(ies) for ${ctx.component.hostname}: ${deployed.join(', ') || '(none)'}`
        : `Policy deploy had ${failures.length} failure(s): ${failures.join(' | ')}`,
    artifacts: { deployed, failures, warnings },
    rollbackData,
  }
}
