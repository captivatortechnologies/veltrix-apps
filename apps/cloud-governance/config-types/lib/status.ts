import type { ComponentConfigStatus, ConfigStatus, PipelineContext } from '@veltrixsecops/app-sdk'

export interface ComponentInspection {
  deployed: boolean
  healthy?: boolean
}

export type ComponentInspector = (componentId: string) => Promise<ComponentInspection>

export const AWS_ACCOUNT_TYPE = 'aws-account'

/**
 * Deployment status from platform records, refined per account by an optional
 * inspector that reads the governance store (registered / compiled / last run).
 */
export async function buildStatus(ctx: PipelineContext, inspect?: ComponentInspector): Promise<ConfigStatus> {
  const { canvas, platform } = ctx
  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }

  const components = await platform.listComponents({ types: [AWS_ACCOUNT_TYPE] })
  const componentStatuses: ComponentConfigStatus[] = []
  for (const component of components) {
    const inspection = inspect ? await inspect(component.id) : { deployed: true }
    const baseHealthy = latest.healthScore != null ? latest.healthScore >= 80 : undefined
    componentStatuses.push({
      componentId: component.id,
      hostname: component.hostname,
      deployed: inspection.deployed,
      version: String(canvas.version),
      lastDeployedAt: latest.completedAt || '',
      healthy: inspection.healthy ?? baseHealthy,
      healthScore: latest.healthScore ?? undefined,
    })
  }
  return {
    deployed: componentStatuses.length === 0 ? true : componentStatuses.some((c) => c.deployed),
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || latest.startedAt,
    componentStatuses,
  }
}
