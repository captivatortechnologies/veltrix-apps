import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { buildStatus } from '../lib/status'
import { resolveStore } from '../lib/store'
import { inspectSchedules } from './_shared'

/** Schedules are tenant-wide, so every account reports the same state: stored, and policies still present. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const store = resolveStore(ctx)
  if (!store) return buildStatus(ctx)
  return buildStatus(ctx, async () => {
    const inspections = await inspectSchedules(store, ctx)
    const deployed = inspections.length > 0 && inspections.every((i) => i.stored !== null)
    return { deployed, healthy: deployed && inspections.every((i) => i.policy !== null && i.stored?.enabled === true) }
  })
}
