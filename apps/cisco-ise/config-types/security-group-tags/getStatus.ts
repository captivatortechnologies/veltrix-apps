import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '@veltrixsecops/app-sdk'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const latest = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) return { deployed: false, version: String(ctx.canvas.version), lastDeployedAt: '', componentStatuses: [] }
  const components = await ctx.platform.listComponents({ types: ['cisco-ise'] })
  const componentStatuses: ComponentConfigStatus[] = components.map((component) => ({ componentId: component.id, hostname: component.hostname, deployed: true, version: String(ctx.canvas.version), lastDeployedAt: latest.completedAt || '', healthy: latest.healthScore != null ? latest.healthScore >= 80 : undefined, healthScore: latest.healthScore ?? undefined }))
  return { deployed: true, version: String(ctx.canvas.version), lastDeployedAt: latest.completedAt || latest.startedAt, componentStatuses }
}
