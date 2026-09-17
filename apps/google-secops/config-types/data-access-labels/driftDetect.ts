import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'
import { buildSecOpsClient, parseJson, readSecOpsSettings, resolveSecOpsCredential } from '../../lib/googlesecops'
import { extractDataAccessLabelSpecs, type LiveDataAccessLabel } from './validate'

const enc = encodeURIComponent

type Diffs = DriftResult['diffs']

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const settings = readSecOpsSettings(ctx.settings)
  const cred = resolveSecOpsCredential(ctx.credential, settings)
  if (!cred) return { hasDrift: false, diffs: [], checked: false }
  const client = buildSecOpsClient(cred, settings)
  const parent = client.parent()

  const specs = extractDataAccessLabelSpecs(ctx.deployedConfig).filter((s) => s.name)
  const diffs: Diffs = []
  // Set when an object could not be read. The run then reports `checked: false`
  // rather than "in sync": the platform treats `hasDrift: false` as verified
  // and clears any outstanding drift record for the component.
  let checkedAll = true
  for (const spec of specs) {
    const getRes = await client.request('GET', `${parent}/dataAccessLabels/${enc(spec.name)}`)
    if (getRes.status === 404) {
      diffs.push({ field: spec.name, expected: 'present', actual: 'absent', severity: 'critical' })
      continue
    }
    if (!getRes.ok) {
      checkedAll = false
      continue
    }
    const live = parseJson<LiveDataAccessLabel>(getRes.body)
    if ((live?.udmQuery ?? '') !== spec.udmQuery) {
      diffs.push({ field: `${spec.name}.udmQuery`, expected: spec.udmQuery, actual: live?.udmQuery ?? '', severity: 'warning' })
    }
    if ((live?.description ?? '') !== spec.description) {
      diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: live?.description ?? '', severity: 'warning' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs, ...(checkedAll ? {} : { checked: false }) }
}
