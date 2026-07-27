import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractPipelineSpecs, type LivePipeline } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractPipelineSpecs(ctx.deployedConfig).filter((s) => s.id && s.processors)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/logProcessingPipelines/${enc(spec.id)}`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LivePipeline>(getRes.body)
    // The server can normalize the processors array, so drift is limited to the
    // stable display name and description scalars.
    if ((live?.displayName ?? '') !== spec.displayName) {
      diffs.push({ field: `${spec.id}.displayName`, expected: spec.displayName, actual: live?.displayName ?? '', severity: 'warning' })
    }
    if ((live?.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.id}.description`, expected: spec.description, actual: live?.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
