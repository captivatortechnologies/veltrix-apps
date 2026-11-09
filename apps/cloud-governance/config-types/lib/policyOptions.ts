import type { OptionItem, OptionsProvider } from '@veltrixsecops/app-sdk'
import { listPolicies } from '../../lib/db'
import { resolveStore } from './store'

export const POLICY_OPTION_LIMIT = 200

/**
 * Tenant policy names for the policy pickers (packs, exceptions, schedules).
 * Without the governance store there is nothing to list, so the picker is
 * empty rather than failing the canvas.
 */
const policyOptions: OptionsProvider = async (ctx): Promise<OptionItem[]> => {
  const store = resolveStore(ctx)
  if (!store) return []
  const query = (ctx.query ?? '').trim().toLowerCase()
  const policies = await listPolicies(store.db, store.customerId)
  return policies
    .filter((policy) => query === '' || policy.name.includes(query) || policy.model.resource.includes(query))
    .slice(0, POLICY_OPTION_LIMIT)
    .map((policy) => ({
      value: policy.name,
      label: policy.name,
      description: `${policy.model.resource} - ${policy.enforcement}`,
    }))
}

export default policyOptions
