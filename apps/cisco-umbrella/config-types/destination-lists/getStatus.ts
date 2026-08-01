import type { ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

/** Deployment status for a destination-lists configuration, from platform records. */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  let lastDeployedAt = ''
  let deployed = false
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    if (prev) {
      deployed = true
      lastDeployedAt = prev.completedAt ?? prev.startedAt ?? ''
    }
  } catch {
    // Status is best-effort — absence of a deployment record just means "not deployed yet".
  }

  const componentStatuses = ctx.component
    ? [
        {
          componentId: ctx.component.id,
          hostname: ctx.component.hostname,
          deployed,
          lastDeployedAt: lastDeployedAt || undefined,
        },
      ]
    : []

  return {
    deployed,
    version: String(ctx.canvas.version ?? ''),
    lastDeployedAt,
    componentStatuses,
  }
}
