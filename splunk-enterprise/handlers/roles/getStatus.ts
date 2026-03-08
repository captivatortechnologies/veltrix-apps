import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '../../../../core/pipeline-engine/types'
import prisma from '../../../../db'

export default async function getStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, customerId } = ctx

  const latestDeployment = await prisma.deployment.findFirst({
    where: { canvasId: canvas.canvasId, customerId, status: 'SUCCEEDED' },
    orderBy: { completedAt: 'desc' },
  })

  if (!latestDeployment) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await prisma.component.findMany({
    where: { customerId, type: { hasSome: ['search-head', 'cluster-manager'] } },
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
