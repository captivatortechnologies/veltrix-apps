import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deleteException, upsertException } from '../../lib/db'
import { isRecord } from '../../lib/model/issues'
import { recompileStoredPolicy } from '../lib/recompile'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { ExceptionRollbackData } from './_shared'

function readRollbackData(value: unknown): ExceptionRollbackData | null {
  if (!isRecord(value) || !Array.isArray(value.exceptions)) return null
  return value as unknown as ExceptionRollbackData
}

/** Restores replaced exceptions, deletes created ones, then recompiles the affected policies. */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }
  const data = readRollbackData(ctx.rollbackData)
  if (!data) return { success: false, message: 'No rollback data recorded for this deployment.' }

  let restored = 0
  let removed = 0
  const failures: string[] = []
  const affected = new Set<string>()

  for (const entry of [...data.exceptions].reverse()) {
    try {
      if (entry.existed && entry.previous) {
        await upsertException(store.db, store.customerId, {
          canvasId: entry.previous.canvasId,
          policyName: entry.policyName,
          resourceId: entry.resourceId,
          reason: entry.previous.reason,
          approver: entry.previous.approver,
          expiresAt: entry.previous.expiresAt,
        })
        restored += 1
      } else {
        await deleteException(store.db, store.customerId, entry.exceptionId)
        removed += 1
      }
      affected.add(entry.policyName)
    } catch (error) {
      failures.push(`${entry.policyName}/${entry.resourceId}: ${errorMessage(error)}`)
    }
  }

  for (const policyName of affected) {
    try {
      await recompileStoredPolicy(store, policyName)
    } catch (error) {
      failures.push(`${policyName}: recompile failed - ${errorMessage(error)}`)
    }
  }

  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Rolled back exceptions: restored ${restored}, removed ${removed}`
        : `Exception rollback had ${failures.length} failure(s): ${failures.join(' | ')}`,
  }
}
