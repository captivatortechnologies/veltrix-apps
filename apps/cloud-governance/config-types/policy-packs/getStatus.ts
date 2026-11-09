import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'
import { buildStatus } from '../lib/status'
import { resolveStore } from '../lib/store'
import { inspectPacks } from './inspect'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const store = resolveStore(ctx)
  if (!store) return buildStatus(ctx)
  return buildStatus(ctx, async (componentId) => {
    const packs = await inspectPacks(store, ctx.canvas, componentId)
    const members = packs.flatMap((p) => p.members)
    const deployed = packs.length > 0 && members.every((m) => m.exists && m.registered)
    return { deployed, healthy: deployed && members.every((m) => m.compiled && !m.lastRunFailed) }
  })
}
