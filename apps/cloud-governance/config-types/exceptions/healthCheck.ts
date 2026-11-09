import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { check, errorMessage, scoreChecks } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { inspectExceptions } from './_shared'

const label = (e: { expected: { policy: string; resourceId: string } }) => `${e.expected.policy}/${e.expected.resourceId}`

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const store = resolveStore(ctx)
  if (!store) return scoreChecks([check('Governance store reachable', false, STORE_UNAVAILABLE)])

  try {
    const inspections = await inspectExceptions(store, ctx, new Date())
    const missing = inspections.filter((i) => !i.stored).map(label)
    const expired = inspections.filter((i) => i.expired).map(label)
    const orphaned = inspections.filter((i) => !i.policyExists).map(label)
    return scoreChecks([
      check('Exceptions stored', missing.length === 0, missing.length === 0 ? `${inspections.length} exception(s) stored` : `Not stored: ${missing.join(', ')}`),
      check('No expired exceptions', expired.length === 0, expired.length === 0 ? 'None expired' : `${expired.length} expired: ${expired.join(', ')}`),
      check('Policies exist', orphaned.length === 0, orphaned.length === 0 ? 'Every exception targets a registered policy' : `No such policy for: ${orphaned.join(', ')}`),
    ])
  } catch (error) {
    return scoreChecks([check('Governance store reachable', false, errorMessage(error))])
  }
}
