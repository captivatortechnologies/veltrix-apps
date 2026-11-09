import type { AppEventContext } from '@veltrixsecops/app-sdk'
import { RUN_ACTION, RUN_MATCH, RUN_STATUS, RECONCILE } from '../lib/runner/contract'
import { handleRunnerEvent, reconcile } from '../lib/runLifecycle'
import { deletePolicyAccountsForComponent } from '../lib/db'

/**
 * Runner messages and the host heartbeat. Every runner message is correlated
 * to the run the account is waiting on inside `handleRunnerEvent`; anything
 * else is ignored there. The hook itself only routes.
 */
export default async function onEvent(ctx: AppEventContext): Promise<void> {
  const { customerId, topic, payload } = ctx
  if (!customerId) throw new Error('Governance events require a verified tenant')
  if (!ctx.events) throw new Error('Governance publisher unavailable')
  const lifecycle = { db: ctx.db, events: ctx.events, appId: ctx.appId, customerId }

  if (topic === RECONCILE) {
    await reconcile(lifecycle, customerId)
    return
  }
  if (topic === 'component:deleted') {
    const componentId = payload?.componentId ?? payload?.id
    if (componentId) await deletePolicyAccountsForComponent(ctx.db, customerId, componentId)
    return
  }
  if (topic === RUN_STATUS || topic === RUN_MATCH || topic === RUN_ACTION) {
    if (!payload?.runId || !payload?.policyId) {
      console.warn('[cloud-governance] Ignoring uncorrelated runner message', { topic })
      return
    }
    await handleRunnerEvent(lifecycle, topic, payload)
  }
}
