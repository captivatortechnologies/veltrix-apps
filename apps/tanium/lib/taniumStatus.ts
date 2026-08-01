// Shared deployment status for every Tanium config type, read from platform
// records. Reports the latest succeeded deployment for the canvas against the
// Tanium server / standalone components the app targets.

import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '@veltrixsecops/app-sdk'

export const TANIUM_TARGET_TYPES = ['tanium-server', 'standalone'] as const

export async function taniumConfigStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: [...TANIUM_TARGET_TYPES] })
  const componentStatuses: ComponentConfigStatus[] = components.map((comp) => ({
    componentId: comp.id,
    hostname: comp.hostname,
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || '',
    healthy: latest.healthScore ? latest.healthScore >= 80 : undefined,
    healthScore: latest.healthScore ?? undefined,
  }))

  return {
    deployed: true,
    version: String(canvas.version),
    lastDeployedAt: latest.completedAt || latest.startedAt,
    componentStatuses,
  }
}
