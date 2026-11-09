import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { resolveStore } from '../lib/store'
import { buildStatus } from '../lib/status'
import { inspectPolicies } from './inspect'

/**
 * Deployed when every policy is stored and registered for the account; healthy
 * when each is compiled and its last run did not fail.
 */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const store = resolveStore(ctx)
  if (!store) return buildStatus(ctx)
  return buildStatus(ctx, async (componentId) => {
    const inspections = await inspectPolicies(store, ctx.canvas, componentId)
    const deployed = inspections.length > 0 && inspections.every((i) => i.policy !== null && i.registered)
    const healthy = deployed && inspections.every((i) => i.policy?.compiledYaml != null && i.lastRun?.status !== 'failed')
    return { deployed, healthy }
  })
}
