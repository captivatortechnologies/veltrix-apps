import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { getPolicyAccount, getPolicyByName, listRuns } from '../../lib/db'
import type { PolicyDto, RunDto } from '../../lib/db'
import { itemsOf } from '../lib/readers'
import { policyNamesOf, readPolicyItem } from '../lib/policyItem'
import type { Store } from '../lib/store'
import { policyTargetsComponent } from '../lib/targets'

export interface PolicyInspection {
  name: string
  policy: PolicyDto | null
  registered: boolean
  lastRun: RunDto | null
}

/** Policies of this component's cloud only; a component is given to narrow, an id alone inspects every policy. */
export async function inspectPolicies(
  store: Store,
  canvas: CanvasSnapshot,
  component: string | { id: string; type?: string[] | null },
): Promise<PolicyInspection[]> {
  const componentId = typeof component === 'string' ? component : component.id
  const items = itemsOf(canvas).filter((item) => typeof component === 'string' || policyTargetsComponent(readPolicyItem(item).model, component))
  const inspections: PolicyInspection[] = []
  for (const name of policyNamesOf(items)) {
    const policy = await getPolicyByName(store.db, store.customerId, name)
    const registered = policy ? (await getPolicyAccount(store.db, store.customerId, policy.id, componentId)) !== null : false
    const lastRun = policy ? ((await listRuns(store.db, store.customerId, { policyId: policy.id, limit: 1 }))[0] ?? null) : null
    inspections.push({ name, policy, registered, lastRun })
  }
  return inspections
}

export const namesWhere = (inspections: PolicyInspection[], predicate: (i: PolicyInspection) => boolean): string[] =>
  inspections.filter(predicate).map((i) => i.name)
