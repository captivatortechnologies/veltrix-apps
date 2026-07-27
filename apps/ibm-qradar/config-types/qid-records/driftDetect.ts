import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQRadarClient, parseJson, readQRadarSettings, resolveQRadarCredential } from '../../lib/qradar'
import { indexByLowerName, listLowLevelCategories } from '../../lib/lookups'
import { extractQidRecordSpecs, type LiveQidRecord } from './validate'

type Diffs = DriftResult['diffs']
const QID_PATH = '/data_classification/qid_records'
const enc = encodeURIComponent

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildQRadarClient(cred, settings)

  const specs = extractQidRecordSpecs(ctx.deployedConfig).filter((s) => s.name && s.lowLevelCategory)
  const categories = await listLowLevelCategories(client)
  const categoryByName = indexByLowerName(categories)

  const diffs: Diffs = []
  for (const spec of specs) {
    const res = await client.request('GET', `${QID_PATH}?filter=${enc(`name="${spec.name}"`)}`, { range: 'items=0-99' })
    const list = res.ok ? parseJson<LiveQidRecord[]>(res.body) : null
    const rec = Array.isArray(list) ? list.find((r) => (r.name ?? '').toLowerCase() === spec.name.toLowerCase()) : undefined
    if (!rec) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    const expectedCategoryId = categoryByName.get(spec.lowLevelCategory.toLowerCase())
    if (expectedCategoryId !== undefined && (rec.low_level_category_id ?? undefined) !== expectedCategoryId) {
      diffs.push({ field: `${spec.name}.lowLevelCategory`, expected: spec.lowLevelCategory, actual: String(rec.low_level_category_id ?? ''), severity: 'warning' })
    }
    if (spec.severity !== undefined && (rec.severity ?? undefined) !== spec.severity) {
      diffs.push({ field: `${spec.name}.severity`, expected: String(spec.severity), actual: String(rec.severity ?? ''), severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
