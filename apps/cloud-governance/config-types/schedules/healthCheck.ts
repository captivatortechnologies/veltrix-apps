import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { enforcementRank } from '../../lib/model'
import { check, errorMessage, scoreChecks } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { inspectSchedules } from './_shared'

const verdict = (names: string[], ok: string, bad: string) => (names.length === 0 ? ok : `${bad}: ${names.join(', ')}`)

export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const store = resolveStore(ctx)
  if (!store) return scoreChecks([check('Governance store reachable', false, STORE_UNAVAILABLE)])

  try {
    const inspections = await inspectSchedules(store, ctx)
    const missing = inspections.filter((i) => !i.stored).map((i) => i.expected.policy)
    const orphaned = inspections.filter((i) => !i.policy).map((i) => i.expected.policy)
    const overreaching = inspections
      .filter((i) => i.stored && i.policy && enforcementRank(i.stored.enforcement) > enforcementRank(i.policy.enforcement))
      .map((i) => i.expected.policy)
    const disabled = inspections.filter((i) => i.stored && !i.stored.enabled).map((i) => i.expected.policy)
    return scoreChecks([
      check('Schedules stored', missing.length === 0, verdict(missing, `${inspections.length} schedule(s) stored`, 'Not stored')),
      check('Policies exist', orphaned.length === 0, verdict(orphaned, 'Every schedule targets a registered policy', 'No such policy')),
      check('Within policy enforcement', overreaching.length === 0, verdict(overreaching, 'No schedule outranks its policy', 'Outranks its policy')),
      check('Enabled', disabled.length === 0, verdict(disabled, 'All schedules enabled', 'Disabled')),
    ])
  } catch (error) {
    return scoreChecks([check('Governance store reachable', false, errorMessage(error))])
  }
}
