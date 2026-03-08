import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '../../../../core/pipeline-engine/types'
import prisma from '../../../../db'

/**
 * Get the current deployment status of index configurations.
 * Queries deployment records and optionally checks live Splunk state.
 */
export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, customerId } = ctx

  // Get the latest deployment for this canvas
  const latestDeployment = await prisma.deployment.findFirst({
    where: {
      canvasId: canvas.canvasId,
      customerId,
      status: 'SUCCEEDED',
    },
    orderBy: { completedAt: 'desc' },
    include: {
      environment: { select: { id: true, name: true } },
    },
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
  const components = await prisma.component.findMany({
    where: {
      customerId,
      type: { hasSome: ['indexer', 'cluster-manager'] },
    },
    select: { id: true, hostname: true },
  })

  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt?.toISOString() || '',
    healthy: latestDeployment.healthScore ? latestDeployment.healthScore >= 80 : undefined,
    healthScore: latestDeployment.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latestDeployment.completedAt?.toISOString() || latestDeployment.startedAt.toISOString(),
    componentStatuses,
  }
}
