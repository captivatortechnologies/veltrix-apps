import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildGraphClient, readGraphSettings, resolveGraphCredential } from '../../lib/graph'
import { extractAttributeSetSpecs, type LiveAttributeSet } from './validate'

const BASE = '/directory/attributeSets'
const SELECT = '?$select=id,description,maxAttributesPerSet'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildGraphClient(cred, settings)

  const specs = extractAttributeSetSpecs(ctx.deployedConfig).filter((s) => s.id)
  const listed = await client.getAll<LiveAttributeSet>(`${BASE}${SELECT}`)
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveById = new Map(listed.items.filter((s) => s.id).map((s) => [s.id!.toLowerCase(), s]))

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveById.get(spec.id.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if ((spec.description || '') !== (live.description ?? '')) {
      diffs.push({
        field: `${spec.id}.description`,
        expected: spec.description || '',
        actual: live.description ?? '',
        severity: 'warning',
      })
    }
    const wantMax = spec.maxAttributesPerSet
    const liveMax = live.maxAttributesPerSet ?? null
    if (wantMax !== liveMax) {
      diffs.push({
        field: `${spec.id}.maxAttributesPerSet`,
        expected: String(wantMax),
        actual: String(liveMax),
        severity: 'warning',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
