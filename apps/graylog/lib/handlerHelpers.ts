// Shared pipeline handlers reused by the Graylog config types added after
// streams. Health and status are identical for every Graylog config type —
// "can we reach the REST API?" and "what does the platform record about the last
// deploy?" — so they live here once and each config type re-exports them as its
// default handler. streams keeps its own inline copies (unchanged).

import type {
  HealthCheckContext,
  HealthCheckResult,
  HealthCheck,
  PipelineContext,
  ConfigStatus,
  ComponentConfigStatus,
} from '@veltrixsecops/app-sdk'
import { buildGraylogUrl, buildAuthHeader, graylogRequest } from './graylogApi'

/** Component types every Graylog config type deploys against. */
export const GRAYLOG_COMPONENT_TYPES = ['graylog', 'standalone']

/**
 * Health for any Graylog config = Graylog answers on its REST API with the
 * configured credential. Read-only: GET /api/system. Any response below 500
 * counts as reachable (auth nuances surface at deploy time, not here).
 */
export async function graylogSystemHealthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
  const { component, credential, connectivity, connectivityProvider } = ctx
  const checks: HealthCheck[] = []

  if (!credential) {
    checks.push({ name: 'credential', passed: false, message: 'No credential attached to this connection.' })
    return { healthy: false, score: 0, checks }
  }

  const base = buildGraylogUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)
  const started = Date.now()
  try {
    const res = await graylogRequest(`${base}/api/system`, { headers, timeoutMs: 8000 })
    const passed = res.status > 0 && res.status < 500
    checks.push({
      name: 'graylog_reachable',
      passed,
      message: passed ? `Graylog reachable (HTTP ${res.status}).` : `Graylog returned HTTP ${res.status}.`,
      latencyMs: Date.now() - started,
    })
  } catch (error) {
    checks.push({
      name: 'graylog_reachable',
      passed: false,
      message: `Graylog unreachable: ${error instanceof Error ? error.message : 'error'}`,
      latencyMs: Date.now() - started,
    })
  }

  const passed = checks.filter((c) => c.passed).length
  return { healthy: passed === checks.length, score: checks.length ? passed / checks.length : 0, checks }
}

/** Deployment status for a Graylog configuration, from platform records. */
export async function graylogConfigStatus(ctx: PipelineContext): Promise<ConfigStatus> {
  const { canvas, platform } = ctx

  const latest = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
  if (!latest) {
    return { deployed: false, version: String(canvas.version), lastDeployedAt: '', componentStatuses: [] }
  }

  const components = await platform.listComponents({ types: GRAYLOG_COMPONENT_TYPES })
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
