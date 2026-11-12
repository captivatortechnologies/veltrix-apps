import { capabilityFor } from './capabilities'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from './graph'
import type { DriftContext, DriftResult, HealthCheckContext, HealthCheckResult } from '@veltrixsecops/app-sdk'

/** Connectivity is a separate check; a reachable endpoint cannot verify a deployment. */
export async function verifyManagedConfiguration(
  ctx: HealthCheckContext,
  checks: HealthCheckResult['checks'],
  detect: (ctx: DriftContext) => Promise<DriftResult>,
  configTypeId = ctx.configTypeId,
): Promise<HealthCheckResult> {
  if (!checks.every(c => c.passed)) return { healthy: false, score: 0, checks }
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (!items.length) {
    checks.push({ name: 'managed-configuration', passed: false, message: 'Connectivity only: no desired resources supplied for verification.' })
  } else {
    try {
      const deployment = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId)
      const entries = (deployment?.rollbackData as { entries?: Array<{ id?: string; itemId?: string; name?: string; appId?: string }> } | undefined)?.entries ?? []
      const cap = capabilityFor(configTypeId)
      const settings = readGraphSettings(ctx.settings)
      const credential = resolveGraphCredential(ctx.credential, settings, ctx.identity)
      if (cap && credential) {
        const client = buildGraphClient(credential, settings)
        for (const entry of entries) {
          if (!entry.id || !items.some(item => entry.itemId ? item.id === entry.itemId
            : String(item.fields?.name ?? item.name ?? item.fields?.appId ?? '').toLowerCase() === String(entry.name ?? entry.appId ?? '').toLowerCase())) continue
          const response = await client.get(`${cap.endpoint}/${encodeURIComponent(entry.id)}?$select=id`)
          if (!response.ok) {
            checks.push({ name: 'managed-identities', passed: false,
              message: `Tracked resource ${entry.id} could not be verified (HTTP ${response.status}); a same-name replacement is not the deployed identity.` })
            return { healthy: false, score: Math.round(checks.filter(c => c.passed).length / checks.length * 100), checks }
          }
        }
      }
      const result = await detect({ ...ctx, deployedConfig: ctx.canvas })
      const incomplete = result.checked === false || result.diffs.some(d => /truncat|not verified|incomplete|unknown target/i.test(String(d.actual)))
      checks.push({ name: 'managed-configuration', passed: !incomplete && !result.hasDrift,
        message: incomplete ? 'Managed-resource verification incomplete; check read access and pagination.'
          : result.hasDrift ? `Managed configuration differs: ${result.diffs.map(d => d.field).join(', ')}`
          : 'Managed fields match the desired configuration.' })
    } catch {
      checks.push({ name: 'managed-configuration', passed: false, message: 'Managed-resource verification failed; no healthy conclusion was reached.' })
    }
  }
  const passed = checks.filter(c => c.passed).length
  return { healthy: passed === checks.length, score: Math.round(passed / checks.length * 100), checks }
}
