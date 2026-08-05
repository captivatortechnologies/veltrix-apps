import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { indexByLowerName, listTaggedFieldCategories } from '../../lib/lookups'
import { extractTaggedFieldSpecs } from './validate'
import { listTaggedFields } from './deploy'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractTaggedFieldSpecs(ctx.deployedConfig).filter((s) => s.name)
  const [categories, live] = await Promise.all([listTaggedFieldCategories(client), listTaggedFields(client)])
  const categoryByName = indexByLowerName(categories)
  const byName = new Map(live.filter((f) => f.name).map((f) => [String(f.name).toLowerCase(), f]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const field = byName.get(spec.name.toLowerCase())
    if (!field) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    // Immutable fields cannot be auto-corrected via redeploy — flagged critical
    // so an operator knows a delete+recreate is required.
    if ((field.type ?? '') !== spec.type) {
      diffs.push({ field: `${spec.name}.type`, expected: spec.type, actual: field.type ?? '', severity: 'critical' })
    }
    if ((field.private_enterprise_number ?? 0) !== spec.privateEnterpriseNumber) {
      diffs.push({ field: `${spec.name}.privateEnterpriseNumber`, expected: String(spec.privateEnterpriseNumber), actual: String(field.private_enterprise_number ?? 0), severity: 'critical' })
    }
    if ((field.element_id ?? 0) !== spec.elementId) {
      diffs.push({ field: `${spec.name}.elementId`, expected: String(spec.elementId), actual: String(field.element_id ?? 0), severity: 'critical' })
    }
    if ((field.is_array ?? false) !== spec.isArray) {
      diffs.push({ field: `${spec.name}.isArray`, expected: String(spec.isArray), actual: String(field.is_array ?? false), severity: 'critical' })
    }
    const expectedCategoryId = categoryByName.get(spec.categoryName.toLowerCase())
    if (expectedCategoryId !== undefined && (field.category_id ?? undefined) !== expectedCategoryId) {
      diffs.push({ field: `${spec.name}.categoryName`, expected: spec.categoryName, actual: String(field.category_id ?? ''), severity: 'warning' })
    }
    if ((field.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: field.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
