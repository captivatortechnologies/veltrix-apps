import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { canonical, extractCrossTenantPartnerSpecs, parseObject, type LiveCrossTenantPartner } from './validate'

const BASE = '/policies/crossTenantAccessPolicy/partners'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractCrossTenantPartnerSpecs(ctx.deployedConfig).filter((s) => s.tenantId)
  const listed = await client.getAll<LiveCrossTenantPartner>(BASE)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByTenant = new Map(
    listed.items.filter((p) => p.tenantId).map((p) => [p.tenantId!.toLowerCase(), p]),
  )

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByTenant.get(spec.tenantId)
    if (!live) {
      diffs.push({ field: spec.tenantId, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const config = parseObject(spec.configuration) ?? {}
    for (const key of Object.keys(config)) {
      const want = canonical(config[key])
      const actual = canonical(live[key])
      if (want !== actual) {
        diffs.push({ field: `${spec.tenantId}.${key}`, expected: want, actual, severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
