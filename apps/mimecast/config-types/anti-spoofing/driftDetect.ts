import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildMimecastClient, extractV1List, readMimecastSettings, resolveMimecastCredential } from '../../lib/mimecast'
import { extractAntiSpoofingSpecs, type LiveAntiSpoofingPolicy } from './validate'
import { definitionEquals } from './deploy'

const LIST = '/policy-management/cloud-gateway/v1/anti-spoofing/policies'

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readMimecastSettings(ctx.settings)
  const cred = resolveMimecastCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildMimecastClient(cred, settings)

  const specs = extractAntiSpoofingSpecs(ctx.deployedConfig).filter((s) => s.description)
  const listed = await client.requestV1('GET', LIST, { query: { pageSize: 100 } })
  if (!listed.ok) return { hasDrift: false, diffs: [] }
  const liveByDesc = new Map<string, LiveAntiSpoofingPolicy>()
  for (const p of extractV1List<LiveAntiSpoofingPolicy>(listed.body)) {
    if (p.description) liveByDesc.set(p.description.toLowerCase(), p)
  }

  const diffs: Diffs = []
  for (const spec of specs) {
    const live = liveByDesc.get(spec.description.toLowerCase())
    if (!live) {
      diffs.push({ field: spec.description, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!definitionEquals(live, spec)) {
      diffs.push({ field: `${spec.description}.definition`, expected: 'declared option/scope', actual: 'differs', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
