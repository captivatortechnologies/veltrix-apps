import type { ComponentConfigStatus, ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx
  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  const components = await platform.listComponents({ types: ['twingate-network'] })
  const componentStatuses: ComponentConfigStatus[] = components.map((component) => ({
    componentId: component.id,
    hostname: component.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || '',
    healthy: latest.healthScore != null ? latest.healthScore >= 80 : undefined,
    healthScore: latest.healthScore ?? undefined,
  }))
  return { deployed: true, version: String(canvas.version), lastDeployedAt: latest.completedAt || latest.startedAt, componentStatuses }
}
