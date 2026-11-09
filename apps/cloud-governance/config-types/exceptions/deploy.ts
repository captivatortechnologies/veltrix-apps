import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { getPolicyByName, listExceptions, upsertException } from '../../lib/db'
import { validateException } from '../../lib/model'
import { readExceptionItem } from '../lib/guardrailItems'
import { recompileStoredPolicy } from '../lib/recompile'
import { itemsOf } from '../lib/readers'
import { errorMessage } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import type { ExceptionRollbackData, ExceptionRollbackEntry } from './_shared'

/**
 * Upserts each exception by (policy, resource), then recompiles the affected
 * policies so the exception filter reaches their registered YAML. An exception
 * for a policy that is not registered yet is stored with a warning and takes
 * effect when that policy is deployed.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const store = resolveStore(ctx)
  if (!store) return { success: false, message: STORE_UNAVAILABLE }

  const entries: ExceptionRollbackEntry[] = []
  const deployed: string[] = []
  const failures: string[] = []
  const warnings: string[] = []
  const affected = new Set<string>()

  try {
    for (const canvasItem of itemsOf(ctx.canvas)) {
      const { value, errors } = validateException(readExceptionItem(canvasItem))
      if (!value) {
        failures.push(`${canvasItem.name}: ${errors.map((e) => e.message).join('; ')}`)
        continue
      }
      const existing = (await listExceptions(store.db, store.customerId, value.policy)).find((e) => e.resourceId === value.resourceId)
      const saved = await upsertException(store.db, store.customerId, {
        canvasId: ctx.canvas.canvasId,
        policyName: value.policy,
        resourceId: value.resourceId,
        reason: value.reason,
        approver: value.approver,
        expiresAt: value.expiresAt,
      })
      entries.push({
        policyName: value.policy,
        resourceId: value.resourceId,
        exceptionId: saved.id,
        existed: existing !== undefined,
        previous: existing
          ? { canvasId: existing.canvasId, reason: existing.reason, approver: existing.approver, expiresAt: existing.expiresAt }
          : null,
      })
      deployed.push(`${value.policy}/${value.resourceId}`)
      affected.add(value.policy)
      if (!(await getPolicyByName(store.db, store.customerId, value.policy))) {
        warnings.push(`Policy "${value.policy}" is not registered yet; the exception applies once it is deployed.`)
      }
    }

    const recompiled: string[] = []
    for (const policyName of affected) {
      const outcome = await recompileStoredPolicy(store, policyName)
      if (outcome.recompiled) recompiled.push(policyName)
      else if (outcome.reason && !outcome.reason.includes('not registered')) warnings.push(`${policyName}: not recompiled - ${outcome.reason}`)
    }
    const rollbackData: ExceptionRollbackData = { exceptions: entries }
    return {
      success: failures.length === 0,
      message:
        failures.length === 0
          ? `Applied ${deployed.length} exception(s); recompiled ${recompiled.length} policy(ies)`
          : `Exception deploy had ${failures.length} failure(s): ${failures.join(' | ')}`,
      artifacts: { deployed, recompiled, failures, warnings },
      rollbackData,
    }
  } catch (error) {
    return {
      success: false,
      message: `Exception deploy failed after ${deployed.length}: ${errorMessage(error)}`,
      artifacts: { deployed, failures, warnings },
      rollbackData: { exceptions: entries } satisfies ExceptionRollbackData,
    }
  }
}
