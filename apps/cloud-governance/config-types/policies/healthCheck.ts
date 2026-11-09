import type { HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'
import { check, errorMessage, scoreChecks } from '../lib/results'
import { resolveStore, STORE_UNAVAILABLE } from '../lib/store'
import { inspectPolicies, namesWhere } from './inspect'


export default async function healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const store = resolveStore(ctx)
  if (!store) return scoreChecks([check('Governance store reachable', false, STORE_UNAVAILABLE)])

  try {
    const inspections = await inspectPolicies(store, ctx.canvas, ctx.component.id)
    const missing = namesWhere(inspections, (i) => !i.policy)
    const uncompiled = namesWhere(inspections, (i) => i.policy !== null && i.policy.compiledYaml === null)
    const unregistered = namesWhere(inspections, (i) => i.policy !== null && !i.registered)
    const failedRuns = namesWhere(inspections, (i) => i.lastRun?.status === 'failed')
    const classes = [...new Set(inspections.map((i) => i.policy?.actionClass).filter((c): c is NonNullable<typeof c> => !!c))]

    return scoreChecks([
      check('Policies stored', missing.length === 0, missing.length === 0 ? `${inspections.length} policy(ies) stored` : `Not stored: ${missing.join(', ')}`),
      check('Policies compiled', uncompiled.length === 0, uncompiled.length === 0 ? 'All policies have compiled YAML' : `No compiled YAML: ${uncompiled.join(', ')}`),
      check(
        'Registered for this account',
        unregistered.length === 0,
        unregistered.length === 0 ? `Registered for ${ctx.component.hostname}` : `Not registered for ${ctx.component.hostname}: ${unregistered.join(', ')}`,
      ),
      check('Action classes', true, classes.length === 0 ? 'none' : classes.join(', ')),
      check('Last runs', failedRuns.length === 0, failedRuns.length === 0 ? `No failed last run` : `Last run failed: ${failedRuns.join(', ')}`),
    ])
  } catch (error) {
    return scoreChecks([check('Governance store reachable', false, errorMessage(error))])
  }
}
