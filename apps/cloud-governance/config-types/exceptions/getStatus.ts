import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { buildStatus } from '../lib/status'
import { resolveStore } from '../lib/store'
import { inspectExceptions } from './_shared'

/** Exceptions are tenant-wide, so every account reports the same state: stored, and none expired. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const store = resolveStore(ctx)
  if (!store) return buildStatus(ctx)
  return buildStatus(ctx, async () => {
    const inspections = await inspectExceptions(store, ctx, new Date())
    const deployed = inspections.length > 0 && inspections.every((i) => i.stored !== null)
    return { deployed, healthy: deployed && inspections.every((i) => !i.expired) }
  })
}
