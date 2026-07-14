import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '@veltrixsecops/app-sdk'

/**
 * Get the current deployment status of a Config File Set.
 * Reads deployment and component records through the platform data API.
 */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latestDeployment = await platform.getLatestDeployment(canvas.canvasId, {
    status: 'SUCCEEDED',
  })

  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({
    types: ['search-head', 'indexer', 'deployment-server', 'heavy-forwarder', 'cluster-manager'],
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
