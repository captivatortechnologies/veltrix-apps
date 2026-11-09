import type { PipelineContext } from '@veltrixsecops/app-sdk'
import { getPolicyByName, listExceptions } from '../../lib/db'
import type { ExceptionDto } from '../../lib/db'
import { validateException } from '../../lib/model'
import type { PolicyException } from '../../lib/model/types'
import { readExceptionItem } from '../lib/guardrailItems'
import { itemsOf } from '../lib/readers'
import type { Store } from '../lib/store'

export interface ExceptionRollbackEntry {
  policyName: string
  resourceId: string
  exceptionId: string
  existed: boolean
  previous: { canvasId: string | null; reason: string; approver: string; expiresAt: string } | null
}

export interface ExceptionRollbackData {
  exceptions: ExceptionRollbackEntry[]
}

export interface ExceptionInspection {
  expected: PolicyException
  stored: ExceptionDto | null
  policyExists: boolean
  expired: boolean
}

export const isExpired = (expiresAt: string, now: Date): boolean => Date.parse(expiresAt) <= now.getTime()

export async function inspectExceptions(store: Store, ctx: Pick<PipelineContext, 'canvas'>, now: Date): Promise<ExceptionInspection[]> {
  const out: ExceptionInspection[] = []
  const policyCache = new Map<string, { exists: boolean; stored: ExceptionDto[] }>()
  for (const item of itemsOf(ctx.canvas)) {
    const { value } = validateException(readExceptionItem(item))
    if (!value) continue
    let known = policyCache.get(value.policy)
    if (!known) {
      known = {
        exists: (await getPolicyByName(store.db, store.customerId, value.policy)) !== null,
        stored: await listExceptions(store.db, store.customerId, value.policy),
      }
      policyCache.set(value.policy, known)
    }
    const stored = known.stored.find((e) => e.resourceId === value.resourceId) ?? null
    out.push({ expected: value, stored, policyExists: known.exists, expired: stored ? isExpired(stored.expiresAt, now) : false })
  }
  return out
}
