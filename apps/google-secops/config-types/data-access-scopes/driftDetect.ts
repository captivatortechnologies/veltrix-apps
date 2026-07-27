import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractDataAccessScopeSpecs, type LiveDataAccessScope } from './validate'
import { labelRefs, refsSignature } from './deploy'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [] }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractDataAccessScopeSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataAccessScopes/${enc(spec.name)}`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) continue
    const live = parseJson<LiveDataAccessScope>(getRes.body)
    if ((live?.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live?.description ?? '', severity: 'warning' })
    }
    if (refsSignature(live?.allowedDataAccessLabels ?? []) !== refsSignature(labelRefs(spec.allowedLabels))) {
      diffs.push({ field: `${spec.name}.allowedLabels`, expected: `${spec.allowedLabels.length} allowed label(s)`, actual: `${(live?.allowedDataAccessLabels ?? []).length} allowed label(s)`, severity: 'warning' })
    }
    if (refsSignature(live?.deniedDataAccessLabels ?? []) !== refsSignature(labelRefs(spec.deniedLabels))) {
      diffs.push({ field: `${spec.name}.deniedLabels`, expected: `${spec.deniedLabels.length} denied label(s)`, actual: `${(live?.deniedDataAccessLabels ?? []).length} denied label(s)`, severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
