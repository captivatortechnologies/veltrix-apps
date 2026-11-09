import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { isRecord } from '../../lib/model/issues'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { deletePolicyAccount } from '../../lib/db'
import type { PackRollbackData } from './_shared'

function readRollbackData(value: unknown): PackRollbackData | null {
  if (!isRecord(value) || !Array.isArray(value.packs) || typeof value.componentId !== 'string') return null
  return value as unknown as PackRollbackData
}

/** Unregisters the members this deploy linked to the account; links that already existed stay. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }
  const data = readRollbackData(ctx.rollbackData)
  if (!data) return { success: false, message: 'No rollback data recorded for this deployment.' }

  let unregistered = 0
  const failures: string[] = []
  for (const pack of [...data.packs].reverse()) {
    for (const member of pack.members) {
      if (member.wasLinked) continue
      try {
        await deletePolicyAccount(store.db, store.customerId, member.policyId, data.componentId)
        unregistered += 1
      } catch (error) {
        failures.push(`${pack.name}/${member.policyName}: ${errorMessage(error)}`)
      }
    }
  }
  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Unregistered ${unregistered} policy link(s) added by the pack deploy`
        : `Pack rollback had ${failures.length} failure(s): ${failures.join(' | ')}`,
  }
}
