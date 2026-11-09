import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { getPolicyAccount, getPolicyByName, listRuns } from '../../lib/db'
import type { PolicyDto, RunDto } from '../../lib/db'
import { itemsOf } from '../lib/readers'
import { policyNamesOf } from '../lib/policyItem'
import type { Store } from '../lib/store'

export interface PolicyInspection {
  name: string
  policy: PolicyDto | null
  registered: boolean
  lastRun: RunDto | null
}

export async function inspectPolicies(store: Store, canvas: CanvasSnapshot, componentId: string): Promise<PolicyInspection[]> {
  const inspections: PolicyInspection[] = []
  for (const name of policyNamesOf(itemsOf(canvas))) {
    const policy = await getPolicyByName(store.db, store.customerId, name)
    const registered = policy ? (await getPolicyAccount(store.db, store.customerId, policy.id, componentId)) !== null : false
    const lastRun = policy ? ((await listRuns(store.db, store.customerId, { policyId: policy.id, limit: 1 }))[0] ?? null) : null
    inspections.push({ name, policy, registered, lastRun })
  }
  return inspections
}

export const namesWhere = (inspections: PolicyInspection[], predicate: (i: PolicyInspection) => boolean): string[] =>
  inspections.filter(predicate).map((i) => i.name)
