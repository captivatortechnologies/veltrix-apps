import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { getPolicyAccount, getPolicyByName, listRuns } from '../../lib/db'
import { validatePack } from '../../lib/model'
import type { PolicyPack } from '../../lib/model/types'
import { readPackItem } from '../lib/packItem'
import { itemsOf } from '../lib/readers'
import type { Store } from '../lib/store'

export interface MemberInspection {
  name: string
  exists: boolean
  compiled: boolean
  registered: boolean
  lastRunFailed: boolean
}

export interface PackInspection {
  pack: PolicyPack
  members: MemberInspection[]
}

export async function inspectPacks(store: Store, canvas: CanvasSnapshot, componentId: string): Promise<PackInspection[]> {
  const out: PackInspection[] = []
  for (const canvasItem of itemsOf(canvas)) {
    const { value: pack } = validatePack(readPackItem(canvasItem))
    if (!pack) continue
    const members: MemberInspection[] = []
    for (const name of pack.policies) {
      const policy = await getPolicyByName(store.db, store.customerId, name)
      const registered = policy ? (await getPolicyAccount(store.db, store.customerId, policy.id, componentId)) !== null : false
      const lastRun = policy ? (await listRuns(store.db, store.customerId, { policyId: policy.id, limit: 1 }))[0] : undefined
      members.push({
        name,
        exists: policy !== null,
        compiled: policy?.compiledYaml != null,
        registered,
        lastRunFailed: lastRun?.status === 'failed',
      })
    }
    out.push({ pack, members })
  }
  return out
}

export const membersWhere = (inspections: PackInspection[], predicate: (m: MemberInspection) => boolean): string[] =>
  inspections.flatMap((p) => p.members.filter(predicate).map((m) => `${p.pack.name}/${m.name}`))
