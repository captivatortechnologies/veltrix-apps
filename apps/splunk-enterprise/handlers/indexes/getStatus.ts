import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '@veltrixsecops/app-sdk'

/**
 * Get the current deployment status of index configurations.
 * Reads deployment and component records through the platform data API.
 */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  // Get the latest successful deployment for this canvas
  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, {
    status: 'SUCCEEDED',
  })

  if (!latestDeployment) {
    return {
      deployed: false,
      version: String(canvas.version),
      lastDeployedAt: '',
      componentStatuses: [],
    }
  }

  // Get components targeted by this canvas
  const components = await platform.listComponents({
    types: ['indexer', 'cluster-manager'],
  })

  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || '',
    healthy: latestDeployment.healthScore ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt || latestDeployment.startedAt,
    componentStatuses,
  }
}
