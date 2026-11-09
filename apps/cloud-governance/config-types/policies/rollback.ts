import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import { deletePolicy, deletePolicyAccount, upsertPolicy } from '../../lib/db'
import { isRecord } from '../../lib/model/issues'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { PolicyRollbackData, PolicyRollbackEntry } from './_shared'

function readRollbackData(value: unknown): PolicyRollbackData | null {
  if (!isRecord(value) || !Array.isArray(value.policies) || typeof value.componentId !== 'string') return null
  return value as unknown as PolicyRollbackData
}

/**
 * Restores each policy to its pre-deploy model and compiled YAML (stored as a
 * new version), or deletes it when this deploy created it. The account link
 * is removed only when this deploy created that link too.
 */
export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }
  const data = readRollbackData(ctx.rollbackData)
  if (!data) return { success: false, message: 'No rollback data recorded for this deployment.' }

  const restored: string[] = []
  const removed: string[] = []
  const failures: string[] = []

  for (const entry of [...data.policies].reverse() as PolicyRollbackEntry[]) {
    try {
      if (entry.existed && entry.previousModel && entry.previousActionClass && entry.previousEnforcement) {
        await upsertPolicy(store.db, store.customerId, {
          canvasId: entry.previousCanvasId,
          model: entry.previousModel,
          compiledYaml: entry.previousCompiledYaml,
          actionClass: entry.previousActionClass,
          enforcement: entry.previousEnforcement,
        })
        if (!entry.accountWasLinked) await deletePolicyAccount(store.db, store.customerId, entry.policyId, data.componentId)
        restored.push(entry.name)
      } else {
        await deletePolicy(store.db, store.customerId, entry.policyId)
        removed.push(entry.name)
      }
    } catch (error) {
      failures.push(`${entry.name}: ${errorMessage(error)}`)
    }
  }

  return {
    success: failures.length === 0,
    message:
      failures.length === 0
        ? `Rolled back policies: restored ${restored.length}, removed ${removed.length}`
        : `Policy rollback had ${failures.length} failure(s): ${failures.join(' | ')}`,
  }
}
