import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { indexByLowerName, listTenantRefs, listUserRoles } from '../../lib/lookups'
import { extractResourceRestrictionSpecs } from './validate'
import { listResourceRestrictions } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractResourceRestrictionSpecs(ctx.deployedConfig).filter((s) => s.targetName)
  const [tenants, roles, live] = await Promise.all([listTenantRefs(client), listUserRoles(client), listResourceRestrictions(client)])
  const tenantByName = indexByLowerName(tenants.filter((t) => !t.deleted))
  const roleByName = indexByLowerName(roles)
  const liveByKey = new Map<string, (typeof live)[number]>()
  for (const r of live) {
    if (typeof r.tenant_id === 'number') liveByKey.set(`tenant:${r.tenant_id}`, r)
    else if (typeof r.role_id === 'number') liveByKey.set(`role:${r.role_id}`, r)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const targetId = spec.targetType === 'tenant' ? tenantByName.get(spec.targetName.toLowerCase()) : roleByName.get(spec.targetName.toLowerCase())
    const label = `${spec.targetType}/${spec.targetName}`
    if (targetId === undefined) {
      diffs.push({ field: label, expected: 'target resolvable', actual: 'target not found', severity: 'warning' })
      continue
    }
    const r = liveByKey.get(`${spec.targetType}:${targetId}`)
    if (!r) {
      diffs.push({ field: label, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (spec.dataWindow !== undefined && (r.data_window ?? undefined) !== spec.dataWindow) {
      diffs.push({ field: `${label}.dataWindow`, expected: String(spec.dataWindow), actual: String(r.data_window ?? ''), severity: 'warning' })
    }
    if (spec.recordLimit !== undefined && (r.record_limit ?? undefined) !== spec.recordLimit) {
      diffs.push({ field: `${label}.recordLimit`, expected: String(spec.recordLimit), actual: String(r.record_limit ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
