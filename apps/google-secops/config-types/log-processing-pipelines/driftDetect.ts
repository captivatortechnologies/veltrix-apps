import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractPipelineSpecs, type LivePipeline } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractPipelineSpecs(ctx.deployedConfig).filter((s) => s.id && s.processors)
  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/logProcessingPipelines/${enc(spec.id)}`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.id, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) {
      checkedAll = false
      continue
    }
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

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
