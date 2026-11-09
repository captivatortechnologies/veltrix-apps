import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { check, errorMessage, scoreChecks } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { inspectPacks, membersWhere } from './inspect'

const verdict = (names: string[], ok: string, bad: string) => (names.length === 0 ? ok : `${bad}: ${names.join(', ')}`)

/** Reasons over the member policies; a pack has no stored state of its own. */
export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const store = resolveStore(ctx)
  if (!store) return scoreChecks([check('Governance store reachable', false, STORE_UNAVAILABLE)])

  try {
    const packs = await inspectPacks(store, ctx.canvas, ctx.component.id)
    const missing = membersWhere(packs, (m) => !m.exists)
    const uncompiled = membersWhere(packs, (m) => m.exists && !m.compiled)
    const unregistered = membersWhere(packs, (m) => m.exists && !m.registered)
    const failed = membersWhere(packs, (m) => m.lastRunFailed)
    return scoreChecks([
      check('Member policies exist', missing.length === 0, verdict(missing, `${packs.length} pack(s) resolved`, 'Missing')),
      check('Member policies compiled', uncompiled.length === 0, verdict(uncompiled, 'All members compiled', 'Not compiled')),
      check('Members registered for this account', unregistered.length === 0, verdict(unregistered, `Registered for ${ctx.component.hostname}`, 'Not registered')),
      check('Member last runs', failed.length === 0, verdict(failed, 'No failed last run', 'Last run failed')),
    ])
  } catch (error) {
    return scoreChecks([check('Governance store reachable', false, errorMessage(error))])
  }
}
