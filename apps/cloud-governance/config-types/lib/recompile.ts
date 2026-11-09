import { compilePolicy } from '../../lib/compiler'
import { getPolicyByName, listActiveExceptions, upsertPolicy } from '../../lib/db'
import type { Store } from './store'
import { toPolicyException } from './results'

export interface RecompileOutcome {
  policyName: string
  recompiled: boolean
  reason?: string
}

/**
 * Re-emit a stored policy's compiled YAML from its stored model and the
 * currently active exceptions. Exceptions compile into the policy as filters,
 * so changing one without this would leave the registered YAML stale.
 */
export async function recompileStoredPolicy(store: Store, policyName: string, now = new Date()): Promise<RecompileOutcome> {
  const policy = await getPolicyByName(store.db, store.customerId, policyName)
  if (!policy) return { policyName, recompiled: false, reason: 'policy is not registered yet' }
  const exceptions = (await listActiveExceptions(store.db, store.customerId, policyName, now)).map(toPolicyException)
  const compiled = compilePolicy(policy.model, { exceptions, now })
  if (!compiled.ok) return { policyName, recompiled: false, reason: compiled.errors.map((e) => e.message).join('; ') }
  await upsertPolicy(store.db, store.customerId, {
    canvasId: policy.canvasId,
    model: policy.model,
    compiledYaml: compiled.yaml,
    actionClass: compiled.actionClass,
    enforcement: policy.enforcement,
  })
  return { policyName, recompiled: true }
}
