import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { extractTenantSpecs } from './validate'
import { listTenants } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractTenantSpecs(ctx.deployedConfig).filter((s) => s.name)
  const live = await listTenants(client)
  const byName = new Map(live.filter((t) => t.name).map((t) => [String(t.name).toLowerCase(), t]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const tenant = byName.get(spec.name.toLowerCase())
    if (!tenant) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((tenant.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: tenant.description ?? '', severity: 'warning' })
    }
    if (spec.eventRateLimit !== undefined && (tenant.event_rate_limit ?? undefined) !== spec.eventRateLimit) {
      diffs.push({ field: `${spec.name}.eventRateLimit`, expected: String(spec.eventRateLimit), actual: String(tenant.event_rate_limit ?? ''), severity: 'warning' })
    }
    if (spec.flowRateLimit !== undefined && (tenant.flow_rate_limit ?? undefined) !== spec.flowRateLimit) {
      diffs.push({ field: `${spec.name}.flowRateLimit`, expected: String(spec.flowRateLimit), actual: String(tenant.flow_rate_limit ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
