// Shared deployment-status resolver for the Keycloak config types.
//
// Status is read purely from platform records (latest SUCCEEDED deployment for the
// canvas, mapped over the app's target component types) — identical across every
// config type, so each getStatus.ts is a thin wrapper around this.

import type { PipelineContext, ConfigStatus, ComponentConfigStatus } from '@veltrixsecops/app-sdk'

/** Component types this app deploys to (mirrors manifest targets.componentTypes). */
export const KEYCLOAK_COMPONENT_TYPES = ['keycloak-realm', 'standalone']

export async function resolveConfigStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: KEYCLOAK_COMPONENT_TYPES })
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
